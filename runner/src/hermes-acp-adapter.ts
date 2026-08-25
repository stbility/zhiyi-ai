/**
 * HermesACPAdapter —— 阶段 C 核心。
 *
 * 通过 ACP(Agent Client Protocol,JSON-RPC over stdio)调用 Hermes Agent
 * Runtime,作为 Runner 的执行适配器(冻结架构 D8:X1 实证通过)。
 *
 * 已验证(v0.20.0,2026-08-17 实证):
 *   - Node.js spawn hermes acp → initialize 握手 ✅
 *   - session/new → acpSessionId ↔ hermesSessionId 映射 ✅
 *   - session/prompt → 流式 session/update(thought/message/tool)✅
 *   - session/cancel → cancel ACK + request_hard_interrupt ✅
 *   - kill server → 客户端 exit 感知 ✅
 *
 * Adapter 职责(不实现 Agent Loop):
 *   生命周期 start/stop + 会话管理 + prompt 流式转发 + cancel
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";

export interface HermesConfig {
  /** hermes 可执行路径(默认 $HOME/.hermes/hermes-agent/venv/bin/hermes) */
  bin?: string;
  /** HERMES_HOME(默认 $HOME/.hermes) */
  home?: string;
  /** ZHIYI MCP 端点(阶段 D 注入) */
  zhiyiMcpUrl?: string;
  /** ZHIYI MCP token(阶段 D 注入,不落盘) */
  zhiyiMcpToken?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

export interface SessionInfo {
  acpSessionId: string;
  hermesSessionId: string;
}

export interface PromptUpdate {
  kind:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_result"
    | "session_created"
    | "turn_complete"
    | "turn_interrupted"
    | "usage_update"
    | "other";
  text?: string;
  name?: string;
  raw?: unknown;
}

export class HermesACPAdapter extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private started = false;
  private readonly config: Required<Pick<HermesConfig, "bin" | "home">> & HermesConfig;

  constructor(config: HermesConfig = {}) {
    super();
    this.config = {
      bin: config.bin ?? `${process.env.HOME}/.hermes/hermes-agent/venv/bin/hermes`,
      home: config.home ?? process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes/hermes-runner`,
      ...config,
    };
  }

  /** 启动 hermes acp 子进程(stdio JSON-RPC) */
  async start(): Promise<void> {
    if (this.started) return;
    const proc = spawn(this.config.bin, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HERMES_HOME: this.config.home,
        ...this.config.env,
      },
    });
    this.proc = proc;
    this.started = true;

    // stderr 转发(日志,不阻塞)
    proc.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      if (!s.includes("Background task failed")) {
        this.emit("stderr", s);
      }
    });

    // 进程退出感知(Runner 崩溃恢复依赖)
    proc.on("exit", (code, sig) => {
      this.started = false;
      this.proc = null;
      this.emit("exit", { code, sig });
      // 拒绝所有 pending(连接断开)
      for (const [, p] of this.pending) {
        p.reject(new Error(`hermes acp exited (code=${code} sig=${sig})`));
      }
      this.pending.clear();
    });

    // stdout JSON-RPC 解析
    this.rl = readline.createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行忽略
      }
      this.handleMessage(msg);
    });

    // 握手
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "zhiyi-agent-runner", version: "0.1.0" },
    });
    this.emit("ready");
  }

  /** 创建 ACP 会话(可带 MCP servers,阶段 D 传 zhiyi) */
  async createSession(mcpServers: unknown[] = []): Promise<SessionInfo> {
    this.assertStarted();
    const res = (await this.request("session/new", {
      cwd: "/tmp",
      mcpServers,
    })) as Record<string, unknown>;
    const meta = (res._meta as Record<string, unknown> | undefined)?.hermes as
      | Record<string, unknown>
      | undefined;
    const provenance = meta?.sessionProvenance as Record<string, unknown> | undefined;
    const acpSessionId =
      (res.session_id as string) ??
      (provenance?.acpSessionId as string | undefined);
    if (!acpSessionId) {
      throw new Error("session/new 未返回 session_id");
    }
    return {
      acpSessionId,
      hermesSessionId:
        (provenance?.currentHermesSessionId as string | undefined) ?? acpSessionId,
    };
  }

  /** 恢复会话(阶段 E checkpoint/resume) */
  async resumeSession(acpSessionId: string, mcpServers: unknown[] = []): Promise<SessionInfo> {
    this.assertStarted();
    await this.request("session/resume", { cwd: "/tmp", sessionId: acpSessionId, mcpServers });
    return { acpSessionId, hermesSessionId: acpSessionId };
  }

  /**
   * 发送 prompt,流式接收 session/update。
   * resolve 时机:session/prompt 的 JSON-RPC 响应到达(ACP 协议保证)
   * 或收到 turn_complete/turn_interrupted 事件(若 Hermes 发送)。
   * 双通道:不依赖任何单一完成信号(实证:turn_complete 事件不可靠)。
   */
  prompt(
    acpSessionId: string,
    text: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ interrupted: boolean }> {
    this.assertStarted();
    const timeoutMs = opts.timeoutMs ?? 300_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`prompt timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const onUpdate = (u: PromptUpdate) => {
        if (u.kind === "turn_interrupted") {
          cleanup();
          resolve({ interrupted: true });
        }
        // turn_complete 事件到达也视为完成(若 Hermes 发送)
        else if (u.kind === "turn_complete") {
          cleanup();
          resolve({ interrupted: false });
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("update", onUpdate);
      };

      this.on("update", onUpdate);
      void this.request("session/prompt", {
        sessionId: acpSessionId,
        prompt: [{ type: "text", text }],
      })
        .then(() => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve({ interrupted: false }); // JSON-RPC 响应 = 该轮完成
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        });
    });
  }

  /** 取消(ACK + hard_interrupt;完成信号由调用方轮询会话状态兜底) */
  async cancel(acpSessionId: string): Promise<void> {
    this.assertStarted();
    await this.request("session/cancel", { sessionId: acpSessionId });
  }

  /** 优雅停止:kill 子进程 */
  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGKILL");
    }
    this.started = false;
  }

  private assertStarted(): void {
    if (!this.started || !this.proc) {
      throw new Error("Hermes ACP 未启动");
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin) throw new Error("stdin 不可用");
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method}`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc!.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // 请求-响应
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    // 服务端推送(session/update 等)
    if (msg.method === "session/update") {
      const params = msg.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      const kindRaw = String(update?.sessionUpdate ?? "other");
      const kind =
        kindRaw === "agent_message_chunk" ||
        kindRaw === "agent_thought_chunk" ||
        kindRaw === "tool_call" ||
        kindRaw === "tool_result" ||
        kindRaw === "session_created" ||
        kindRaw === "turn_complete" ||
        kindRaw === "turn_interrupted" ||
        kindRaw === "usage_update"
          ? kindRaw
          : "other";
      const content = (update?.content ?? {}) as Record<string, unknown>;
      this.emit("update", {
        kind,
        text: content.text as string | undefined,
        name: content.name as string | undefined,
        raw: msg,
      } satisfies PromptUpdate);
    }
  }
}
