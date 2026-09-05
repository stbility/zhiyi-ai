/**
 * Runner 主循环(阶段 B 骨架,冻结架构)。
 *
 * 职责:
 *   poll → claim(FOR UPDATE SKIP LOCKED)→ execute(占槽位)→ finish
 *   + 心跳续租 + graceful shutdown + fence lost 处理
 *
 * Runner 是执行承载层,不是 Agent 实现:
 *   - Agent Loop 由 Hermes ACP 提供(阶段 C)
 *   - 本文件只负责领取/租约/槽位/终态,execute 回调由 adapter 注入
 */

import { SlotPool } from "./slot-pool.js";
import { claimRun, type ClaimResult } from "./claim.js";
import { renewLease } from "./heartbeat.js";
import { finishFenced } from "./fence.js";

export interface RunnerConfig {
  workerId: string;
  /** 租约时长 ms(默认 90s) */
  leaseMs?: number;
  /** 心跳间隔 ms(默认 60s,须小于 leaseMs) */
  heartbeatMs?: number;
  /** 轮询间隔 ms(默认 3s) */
  pollMs?: number;
  /** 并发槽位数(默认 2) */
  slots?: number;
  /** 内部 lease 恢复扫描间隔 ms(默认 30s;0 = 禁用)。
   *  Runner 进程内定时调 recover_expired_agent_runs RPC(用户批准的最小实现,
   *  不依赖 Vercel Cron / 套餐升级) —— 崩溃恢复 E2E 需要它触发 lease 过期恢复。 */
  recoveryMs?: number;
}

export interface ExecuteContext {
  run: ClaimResult;
  workerId: string;
  leaseGeneration: number;
  /** fence lost 或租约失效时调用,触发优雅退出 */
  signal: {
    onFenceLost: (fn: () => void) => void;
    isAborted: () => boolean;
  };
}

/** 执行回调(阶段 C 注入:ACP session + prompt + checkpoint) */
export type ExecuteHandler = (ctx: ExecuteContext) => Promise<void>;

export interface RunnerDeps {
  /** 已连接的 pg 连接池 */
  pool: import("pg").Pool;
  execute: ExecuteHandler;
  config: RunnerConfig;
  onStateChange?: (state: {
    busy: number;
    total: number;
    phase: "idle" | "claiming" | "running" | "shutting-down";
  }) => void;
}

const TERMINAL = ["completed", "failed", "interrupted", "cancelled"] as const;

export class Runner {
  private readonly pool: import("pg").Pool;
  private readonly execute: ExecuteHandler;
  private readonly config: Required<RunnerConfig>;
  private readonly slots: SlotPool;
  private readonly onStateChange?: RunnerDeps["onStateChange"];
  private shuttingDown = false;
  private timers: NodeJS.Timeout[] = [];
  private abortControllers = new Map<string, AbortController>();

  constructor(deps: RunnerDeps) {
    this.pool = deps.pool;
    this.execute = deps.execute;
    this.onStateChange = deps.onStateChange;
    this.config = {
      leaseMs: deps.config.leaseMs ?? 90_000,
      heartbeatMs: deps.config.heartbeatMs ?? 60_000,
      pollMs: deps.config.pollMs ?? 3_000,
      slots: deps.config.slots ?? 2,
      workerId: deps.config.workerId,
      recoveryMs: deps.config.recoveryMs ?? 30_000,
    };
    this.slots = new SlotPool(this.config.slots);
  }

  /** 启动主循环(不阻塞,返回后由调用方保持进程存活) */
  start(): void {
    void this.loop();
    // 内部 lease 恢复定时器(用户批准:Runner 进程内定期调 RPC,
    // 不依赖 Vercel Cron / 套餐升级)。0 = 禁用。
    if (this.config.recoveryMs > 0) {
      const t = setInterval(() => void this.runRecoveryScan(), this.config.recoveryMs);
      this.timers.push(t);
    }
  }

  /** 内部恢复扫描:调 recover_expired_agent_runs RPC(只标记,不执行 Agent) */
  private async runRecoveryScan(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // 直接调 RPC(service role 有 EXECUTE,0068 已收口最小权限)
      const res = await client.query(
        `SELECT public.recover_expired_agent_runs() AS recovered`,
      );
      const recovered = res.rows[0]?.recovered;
      if (recovered && (recovered.interrupted || recovered.failed)) {
        console.log(
          `[runner] recovery scan: ${JSON.stringify(recovered)}`,
        );
      }
    } catch (err) {
      console.error(`[runner] recovery scan error:`, err);
    } finally {
      client.release();
    }
  }

  /** 优雅关闭:停止 poll → 等待执行中的 run 到 step 边界 */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.emit({ ...this.slotsStatus(), phase: "shutting-down" });
    // 停止所有轮询定时器
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // 等待槽位全部释放(最多等 60s,之后强杀)
    const deadline = Date.now() + 60_000;
    while (this.slots.busyCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    // 未结束的 run:abort(lease 自然过期,由接管机制恢复)
    for (const [runId, ac] of this.abortControllers) {
      ac.abort();
      this.abortControllers.delete(runId);
    }
  }

  /** 健康检查:当前状态 */
  status(): {
    phase: string;
    slots: { total: number; busy: number };
    workerId: string;
    running: string[];
  } {
    return {
      phase: this.shuttingDown ? "shutting-down" : "running",
      slots: this.slots.status(),
      workerId: this.config.workerId,
      running: [...this.abortControllers.keys()],
    };
  }

  private emit(state: Parameters<NonNullable<RunnerDeps["onStateChange"]>>[0]): void {
    this.onStateChange?.(state);
  }

  private async loop(): Promise<void> {
    while (!this.shuttingDown) {
      // 有空闲槽位才 poll
      if (this.slots.hasFreeSlot()) {
        this.emit({ ...this.slotsStatus(), phase: "claiming" });
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const run = await claimRun(client, {
            workerId: this.config.workerId,
            leaseMs: this.config.leaseMs,
          });
          if (run) {
            await client.query("COMMIT");
            // 释放连接(claim 已完成,执行期间不再持有事务连接)
            client.release();
            void this.runInSlot(run);
            // 立刻下一轮 poll(可能还有任务)
            continue;
          }
          await client.query("ROLLBACK");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          console.error("[runner] claim error:", err);
        } finally {
          client.release();
        }
        this.emit({ ...this.slotsStatus(), phase: "idle" });
      }
      // 等下一个 poll 周期
      await new Promise((r) => setTimeout(r, this.config.pollMs));
    }
  }

  private slotsStatus(): { busy: number; total: number } {
    return this.slots.status();
  }

  /** 在一个槽位里执行 run(claim 已成功) */
  private async runInSlot(run: ClaimResult): Promise<void> {
    this.slots.acquire();
    this.emit({ ...this.slotsStatus(), phase: "running" });
    const ac = new AbortController();
    this.abortControllers.set(run.runId, ac);

    const heartbeatTimer = setInterval(() => {
      void this.heartbeat(run);
    }, this.config.heartbeatMs);
    this.timers.push(heartbeatTimer);

    // fence lost 处理:abort + 停止执行(执行回调检查 isAborted)
    const onFenceLost = () => ac.abort();
    const ctx: ExecuteContext = {
      run,
      workerId: this.config.workerId,
      leaseGeneration: run.leaseGeneration,
      signal: {
        onFenceLost,
        isAborted: () => ac.signal.aborted,
      },
    };

    try {
      await this.execute(ctx);
      // 执行成功后,若未被 fence/cancel 拦截,确保终态已写
      // (execute 回调内部负责 finish;这里兜底检查)
    } catch (err) {
      console.error(`[runner] run ${run.runId} execute error:`, err);
      // 未正常 finish 的 run:置 failed(带 fence 校验)
      const client = await this.pool.connect();
      try {
        await finishFenced(
          {
            pg: client,
            runId: run.runId,
            leaseGeneration: run.leaseGeneration,
          },
          this.config.workerId,
          "failed",
          err instanceof Error ? err.message.slice(0, 500) : "runner execute error",
        );
      } catch (e) {
        console.error(`[runner] run ${run.runId} finish-failed fallback error:`, e);
      } finally {
        client.release();
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.abortControllers.delete(run.runId);
      this.slots.release();
      this.emit({ ...this.slotsStatus(), phase: "idle" });
    }
  }

  private async heartbeat(run: ClaimResult): Promise<void> {
    const client = await this.pool.connect();
    try {
      const ok = await renewLease({
        pg: client,
        runId: run.runId,
        workerId: this.config.workerId,
        leaseGeneration: run.leaseGeneration,
        leaseMs: this.config.leaseMs,
      });
      if (!ok) {
        // fence lost / terminal → 停止执行
        console.warn(
          `[runner] run ${run.runId} heartbeat rejected (fence lost or terminal), aborting`,
        );
        this.abortControllers.get(run.runId)?.abort();
      }
    } catch (err) {
      console.error(`[runner] run ${run.runId} heartbeat error:`, err);
    } finally {
      client.release();
    }
  }
}

/** 默认 workerId 生成(hostname+pid+ts) */
export function makeWorkerId(): string {
  const host = (process.env.HOSTNAME ?? "local").slice(0, 24);
  return `runner-${host}-${process.pid}-${Date.now().toString(36)}`;
}
