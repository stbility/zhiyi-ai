/**
 * Agent 执行 handler —— 注入 Runner 的 execute 回调(阶段 D)。
 *
 * 完整链路(冻结架构):
 *   claim(已由 Runner 完成)
 *   → Hermes ACP:createSession(带 ZHIYI MCP)/ resumeSession(续跑)
 *   → session/prompt(任务文本)
 *   → 流式 session/update → 映射 agent_steps + checkpoint(fence 校验)
 *   → finish(completed / interrupted / failed)
 *
 * Hermes 负责:model reasoning / tool selection / tool execution / continuation
 * Runner 负责:run lifecycle / lease / fencing / persistence / usage
 */

import { HermesACPAdapter, type SessionInfo } from "./hermes-acp-adapter.js";
import type { ExecuteContext } from "./runner.js";
import { insertStepFenced, updateCheckpointFenced, finishFenced } from "./fence.js";
import type pg from "pg";

export interface AgentExecuteDeps {
  pool: pg.Pool;
  acp: HermesACPAdapter;
  /** ZHIYI MCP server 描述(阶段 D:注入 mcpServers) */
  zhiyiMcp?: { url: string; token: string };
}

/** ACP session → agent_runs 的映射(阶段 E 恢复用,存 agent_runs 扩展字段) */
export interface RunSessionMapping {
  runId: string;
  acpSessionId: string;
  hermesSessionId: string;
  leaseGeneration: number;
}

/** 把一个 session 映射记录持久化到 agent_runs(阶段 E 恢复依赖) */
export async function persistSessionMapping(
  pg: pg.PoolClient,
  mapping: RunSessionMapping,
): Promise<void> {
  // 存储到 agent_runs(用现有列可容纳的 JSON 字段;0065 无 session 列,
  // 这里存到 error_message 之外 —— 需确认:主仓 agent_runs 无 meta 列。
  // 阶段 E 若需持久映射,加 0066 列(待确认)。此处先日志 + 返回。
  console.log(
    `[runner] session mapping run=${mapping.runId} acp=${mapping.acpSessionId} hermes=${mapping.hermesSessionId} gen=${mapping.leaseGeneration}`,
  );
}

/** 构造 MCP servers 参数(传给 session/new) */
function zhiyiMcpServers(deps: AgentExecuteDeps): unknown[] {
  if (!deps.zhiyiMcp) return [];
  return [
    {
      name: "zhiyi",
      transport: "http",
      url: deps.zhiyiMcp.url,
      headers: { Authorization: `Bearer ${deps.zhiyiMcp.token}` },
    },
  ];
}

/** Runner execute handler:claim 后执行一个 run(阶段 D 实现) */
export async function executeAgentRun(
  ctx: ExecuteContext,
  deps: AgentExecuteDeps,
): Promise<void> {
  const { run, workerId, leaseGeneration, signal } = ctx;
  const client = await deps.pool.connect();
  let session: SessionInfo | null = null;

  const fenceCtx = { pg: client, runId: run.runId, leaseGeneration };

  try {
    // 1. 创建/恢复 ACP 会话(带 ZHIYI MCP)
    const mcpServers = zhiyiMcpServers(deps);
    session = run.status === "interrupted"
      ? null // 阶段 E:从持久化的 acpSessionId resume(0066 列待确认)
      : await deps.acp.createSession(mcpServers);
    if (run.status !== "interrupted" && session) {
      await persistSessionMapping(client, {
        runId: run.runId,
        acpSessionId: session.acpSessionId,
        hermesSessionId: session.hermesSessionId,
        leaseGeneration,
      });
    }

    // 2. 发送任务 prompt(任务文本来自 agent_runs —— 需从 conversation/messages 取;
    //    阶段 D 先用占位:直接发"执行任务",阶段 E 接真实消息重建)
    const taskText = `你是智一智能体,请执行用户的任务。任务内容见主仓对话上下文。`;
    const promptResult = await deps.acp.prompt(
      session!.acpSessionId,
      taskText,
      { timeoutMs: 270_000 },
    );

    // 3. prompt 期间 fence 检查(被接管则立即停止)
    if (signal.isAborted()) {
      console.warn(`[runner] run ${run.runId} aborted during prompt`);
      return; // 不 finish —— lease 已被接管,由接管者处理
    }

    // 4. 完成 → finish(fence CAS)
    const outcome = promptResult.interrupted ? "interrupted" : "completed";
    const ok = await finishFenced(fenceCtx, workerId, outcome);
    console.log(
      `[runner] run ${run.runId} ${outcome} finish=${ok} (gen=${leaseGeneration})`,
    );
    if (!ok) {
      // fence lost → 退出,不继续
      signal.onFenceLost(() => {});
    }
  } catch (err) {
    // 异常 → failed(带 fence 校验)
    console.error(`[runner] run ${run.runId} execute error:`, err);
    if (!signal.isAborted()) {
      await finishFenced(
        fenceCtx,
        workerId,
        "failed",
        err instanceof Error ? err.message.slice(0, 500) : "agent execute error",
      );
    }
  } finally {
    client.release();
  }
}
