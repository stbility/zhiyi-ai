/**
 * Agent 执行 handler —— 注入 Runner 的 execute 回调(阶段 D+E)。
 *
 * 完整链路(冻结架构):
 *   claim(已由 Runner 完成)
 *   → Hermes ACP:createSession(带 ZHIYI MCP)/ resumeSession(续跑)
 *   → 持久化 acp_session_id(0066 列,中断恢复依赖)
 *   → session/prompt(任务文本,来自 conversation messages)
 *   → 流式 session/update → 逐步映射 agent_steps + usage + checkpoint(fence)
 *   → finish(completed / interrupted / failed)
 *
 * Usage exactly-once:step INSERT + usage UPSERT 同一事务(阶段 E)。
 */

import { HermesACPAdapter, type SessionInfo } from "./hermes-acp-adapter.js";
import type { ExecuteContext } from "./runner.js";
import { insertStepFenced, updateCheckpointFenced, finishFenced } from "./fence.js";
import { bumpUsageInTx, currentPeriodMonth } from "./usage.js";
import type pg from "pg";

export interface AgentExecuteDeps {
  pool: pg.Pool;
  acp: HermesACPAdapter;
  /** ZHIYI MCP server 描述(阶段 D:注入 mcpServers) */
  zhiyiMcp?: { url: string; token: string };
  /** 任务文本来源(从 conversation/messages 取,默认占位) */
  resolveTaskText?: (ctx: ExecuteContext, client: pg.PoolClient) => Promise<string>;
}

/** ACP session → agent_runs 映射(写 0066 列) */
export async function persistSessionMapping(
  client: pg.PoolClient,
  mapping: {
    runId: string;
    acpSessionId: string;
    hermesSessionId: string;
    leaseGeneration: number;
  },
): Promise<void> {
  const res = await client.query(
    `
    UPDATE public.agent_runs
    SET acp_session_id = $2,
        hermes_session_id = $3,
        updated_at = now()
    WHERE id = $1
      AND lease_generation = $4
    RETURNING id
    `,
    [mapping.runId, mapping.acpSessionId, mapping.hermesSessionId, mapping.leaseGeneration],
  );
  if (res.rows.length === 0) {
    throw new Error(`session mapping fence lost (run=${mapping.runId} gen=${mapping.leaseGeneration})`);
  }
}

/** 读取已持久化的 ACP 会话(interrupted resume 用) */
export async function loadSessionMapping(
  client: pg.PoolClient,
  runId: string,
): Promise<{ acpSessionId: string | null; hermesSessionId: string | null }> {
  const res = await client.query(
    `
    SELECT acp_session_id, hermes_session_id
    FROM public.agent_runs
    WHERE id = $1
    `,
    [runId],
  );
  const row = res.rows[0];
  return {
    acpSessionId: row?.acp_session_id ?? null,
    hermesSessionId: row?.hermes_session_id ?? null,
  };
}

/** 构造 MCP servers 参数(传给 session/new 或 session/resume) */
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

/** 默认任务文本解析:从 conversation 的最新 user 消息取任务(真实实现) */
async function defaultTaskText(ctx: ExecuteContext, client: pg.PoolClient): Promise<string> {
  // 从 messages 读该 conversation 最新的 user 消息(服务端直查,不受 RLS 影响)
  const res = await client.query(
    `
    SELECT content
    FROM public.messages
    WHERE conversation_id = $1
      AND role = 'user'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [ctx.run.conversationId],
  );
  const content = res.rows[0]?.content as string | undefined;
  if (!content || !content.trim()) {
    // 无消息兜底(理论不会发生,run 由用户消息触发)
    return `执行智能体任务(run=${ctx.run.runId})。`;
  }
  return content;
}

/** Runner execute handler:claim 后执行一个 run(阶段 D+E) */
export async function executeAgentRun(
  ctx: ExecuteContext,
  deps: AgentExecuteDeps,
): Promise<void> {
  const { run, workerId, leaseGeneration, signal } = ctx;
  const client = await deps.pool.connect();
  let session: SessionInfo | null = null;

  const fenceCtx = { pg: client, runId: run.runId, leaseGeneration };

  try {
    // 1. 会话:interrupted → resume(读 0066 列);queued → create(带 ZHIYI MCP)
    const mcpServers = zhiyiMcpServers(deps);
    if (run.status === "interrupted" && run.resumable) {
      const mapped = await loadSessionMapping(client, run.runId);
      if (mapped.acpSessionId) {
        session = await deps.acp.resumeSession(mapped.acpSessionId, mcpServers);
        console.log(
          `[runner] run ${run.runId} resumed acp session ${mapped.acpSessionId.slice(0, 12)}...`,
        );
      } else {
        console.warn(
          `[runner] run ${run.runId} interrupted but no acp_session_id — starting new session`,
        );
        session = await deps.acp.createSession(mcpServers);
        await persistSessionMapping(client, {
          runId: run.runId,
          acpSessionId: session.acpSessionId,
          hermesSessionId: session.hermesSessionId,
          leaseGeneration,
        });
      }
    } else {
      session = await deps.acp.createSession(mcpServers);
      await persistSessionMapping(client, {
        runId: run.runId,
        acpSessionId: session.acpSessionId,
        hermesSessionId: session.hermesSessionId,
        leaseGeneration,
      });
      console.log(
        `[runner] run ${run.runId} new acp session ${session.acpSessionId.slice(0, 12)}...`,
      );
    }

    // 2. 任务文本(从 conversation 最新 user 消息读取)
    const taskText = deps.resolveTaskText
      ? await deps.resolveTaskText(ctx, client)
      : await defaultTaskText(ctx, client);

    // 3. prompt(长时执行,预算由 runner 主循环控制)
    const promptResult = await deps.acp.prompt(session.acpSessionId, taskText, {
      timeoutMs: 270_000,
    });

    // 4. fence 检查(被接管则立即停止,不 finish)
    if (signal.isAborted()) {
      console.warn(`[runner] run ${run.runId} aborted during prompt (fence lost)`);
      return;
    }

    // 5. 完成 → finish(fence CAS)
    const outcome = promptResult.interrupted ? "interrupted" : "completed";
    const ok = await finishFenced(fenceCtx, workerId, outcome);
    console.log(
      `[runner] run ${run.runId} ${outcome} finish=${ok} (gen=${leaseGeneration})`,
    );
    if (!ok) {
      // fence lost → 退出(接管者负责)
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
