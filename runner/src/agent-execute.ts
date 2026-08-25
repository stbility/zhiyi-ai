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

import { HermesACPAdapter, type PromptUpdate, type SessionInfo } from "./hermes-acp-adapter.js";
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
  // ACP 协议 HttpMcpServer:{ type:'http', name, url, headers: [{name, value}] }。
  // 2026-08-23 修复:此前传 { transport, headers:{...} } 缺 type 且 headers 用映射对象
  // —— discriminated union 校验报 type required + list_type,实测 422。
  return [
    {
      type: "http",
      name: "zhiyi",
      url: deps.zhiyiMcp.url,
      headers: [{ name: "Authorization", value: `Bearer ${deps.zhiyiMcp.token}` }],
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

    // 2.5 usage 归属:conversation → user_id(计量必需,阶段 E 契约)
    let runUserId: string | undefined;
    try {
      const userRes = await client.query(
        `SELECT user_id FROM public.conversations WHERE id = $1`,
        [ctx.run.conversationId],
      );
      runUserId = userRes.rows[0]?.user_id as string | undefined;
    } catch (e) {
      console.warn(
        `[runner] run ${ctx.run.runId} 读取归属用户失败(本次不计量)`,
      );
    }

    // 3. prompt(长时执行,预算由 runner 主循环控制)。
    //    监听 ACP update 流:每个 tool_result 落一条 agent_steps + 推进
    //    checkpoint + usage 计量(exactly-once,同一事务 —— 阶段 E 契约,
    //    2026-08-23 补全:此前 imports 存在但从未调用,任务不落步骤、不计费)。
    let stepBase = ctx.run.currentStep;
    let writeChain: Promise<void> = Promise.resolve();
    // 回复落库(交付闭环):收集本会话的 agent_message_chunk → prompt 后写 messages
    let outputText = "";
    // ToolCallStart(session_update="tool_call")→ 记 title;ToolCallProgress
    // (session_update="tool_call_update",adapter 已归一化为 tool_call)→ 落库
    const pendingTitles = new Map<string, string>();
    const onUpdate = (u: PromptUpdate) => {
      const raw = u.raw as
        | {
            params?: {
              sessionId?: string;
              update?: Record<string, unknown> & { content?: unknown };
            };
          }
        | undefined;
      // adapter 全局 emit,只处理本会话的更新
      const rawSessionId = raw?.params?.sessionId;
      if (rawSessionId && rawSessionId !== session?.acpSessionId) return;
      if (u.kind === "agent_message_chunk") {
        const upd = raw?.params?.update ?? {};
        const contentRaw = upd.content;
        const chunk = Array.isArray(contentRaw)
          ? (contentRaw as { text?: string }[]).map((c) => c.text ?? "").join("")
          : typeof contentRaw === "object" && contentRaw !== null
            ? String((contentRaw as { text?: string }).text ?? "")
            : String(contentRaw ?? "");
        if (chunk) outputText += chunk;
        return;
      }
      if (u.kind !== "tool_call") return;
      const upd = raw?.params?.update ?? {};
      const su = String(upd.sessionUpdate ?? "");
      const callId = String(upd.toolCallId ?? "");
      if (su === "tool_call") {
        // ToolCallStart:先记录工具标题,等 completed 时配对
        if (callId) {
          pendingTitles.set(
            callId,
            typeof upd.title === "string" && upd.title !== ""
              ? upd.title
              : "tool",
          );
        }
        return;
      }
      // ToolCallProgress(completed/failed)
      const status = String(upd.status ?? "");
      if (status !== "completed" && status !== "failed") return;
      const name =
        pendingTitles.get(callId) ??
        (typeof upd.title === "string" && upd.title !== ""
          ? upd.title
          : "tool");
      if (callId) pendingTitles.delete(callId);
      // content 是 ContentBlock 数组(adapter 只提取了 content.text,数组时为空)
      const contentRaw = upd.content;
      const text = Array.isArray(contentRaw)
        ? (contentRaw as { text?: string }[]).map((c) => c.text ?? "").join("")
        : String(contentRaw ?? "");
      const preview = text.slice(0, 500);
      const idx = stepBase + 100;
      stepBase = idx;
      // 串行化写入(避免并发乱序);每步一个事务:step + checkpoint + usage
      writeChain = writeChain.then(async () => {
        const c = await deps.pool.connect();
        try {
          await c.query("BEGIN");
          const stepOk = await insertStepFenced(
            { pg: c, runId: ctx.run.runId, leaseGeneration },
            {
              stepIndex: idx,
              toolCallId: null,
              toolName: name,
              arguments: upd.arguments ?? null,
              resultPreview: preview,
              resultChars: text.length,
              previewChars: preview.length,
              truncated: text.length > 500,
              durationMs: null,
              ok: status !== "failed",
            },
          );
          if (stepOk) {
            await updateCheckpointFenced(
              { pg: c, runId: ctx.run.runId, leaseGeneration },
              idx,
            );
            if (runUserId) {
              await bumpUsageInTx(c, {
                userId: runUserId,
                periodMonth: currentPeriodMonth(),
                category: "agent_turns",
                units: 1,
              });
            }
          }
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          console.error(`[runner] run ${ctx.run.runId} 步骤落库失败:`, e);
        } finally {
          c.release();
        }
      });
    };
    deps.acp.on("update", onUpdate);
    let promptResult: Awaited<ReturnType<HermesACPAdapter["prompt"]>>;
    try {
      promptResult = await deps.acp.prompt(session.acpSessionId, taskText, {
        timeoutMs: 270_000,
      });
      await writeChain; // 等所有步骤写入完成,再进入 finish
    } finally {
      deps.acp.off("update", onUpdate);
    }

    // 3.5 回复落库(交付闭环:用户页面可见 Runner 执行的回复,
    //     2026-08-23 补全 —— 此前 Runner 完成 run 后 messages 无 assistant 行)
    if (outputText.trim() !== "") {
      try {
        await client.query(
          `INSERT INTO public.messages
             (conversation_id, organization_id, role, content, provider_id, model_id, created_at, run_id)
           VALUES ($1, $2, 'assistant', $3, NULL, NULL, now(), $4)`,
          [
            ctx.run.conversationId,
            ctx.run.organizationId,
            outputText.trim(),
            ctx.run.runId,
          ],
        );
      } catch (e) {
        console.error(`[runner] run ${ctx.run.runId} 回复落库失败:`, e);
      }
    }

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
