import type { SupabaseClient } from "@supabase/supabase-js";

import { getSiteUrl } from "@/lib/env/server";
import { readAgentStream } from "@/lib/ai/read-agent-stream";
import {
  EVAL_CASES,
  checkEvalCase,
  dbRowToEvalCase,
  type EvalCase,
} from "@/lib/eval/cases";

/** 加载调用者自己的反馈用例(反馈飞轮消费端) */
export async function loadDynamicCases(
  supabase: SupabaseClient,
  userId: string,
): Promise<EvalCase[]> {
  const { data, error } = await supabase
    .from("eval_cases")
    .select("key, name, prompt, must_contain, must_contain_any, must_not_contain, timeout_ms")
    .eq("created_by", userId)
    .eq("enabled", true)
    .order("created_at", { ascending: false });
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => dbRowToEvalCase(r as never));
}

/**
 * 评测 runner:一键跑完 20 条用例,结果落 eval_runs。
 *
 * 执行方式与工作流步骤一致:内部调用 /api/agent(带调用者会话 cookie),
 * 走真实的 preflight(模型解析、额度、记忆/知识库注入)—— 评测的就是
 * 生产链路本身,不是绕过生产逻辑的单元测试。
 *
 * 预算护栏:server action 有 maxDuration 上限,逐条跑不完就如实标记
 * 剩余为 skipped,运行状态记 partial —— 绝不假装跑完了。
 */

export const EVAL_BUDGET_MS = 240_000; // 留 60s 给落库与返回

export interface EvalCaseRecord {
  readonly key: string;
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped" | "timeout";
  readonly output: string;
  readonly error: string | null;
  readonly durationMs: number;
}

export interface EvalRunSummary {
  readonly status: "completed" | "partial";
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly passRate: number;
}

export interface EvalRunResult {
  readonly summary: EvalRunSummary;
  readonly records: readonly EvalCaseRecord[];
}

async function runOneCase(
  c: EvalCase,
  cookieHeader: string,
): Promise<{ status: "passed" | "failed" | "timeout"; output: string; error: string | null }> {
  try {
    const res = await fetch(`${getSiteUrl()}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ input: c.prompt }),
      signal: AbortSignal.timeout(c.timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { status: "failed", output: "", error: body?.error ?? `HTTP ${res.status}` };
    }
    const output = await readAgentStream(res);
    const verdict = checkEvalCase(c, output);
    return { status: verdict.status, output, error: verdict.reason };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const timedOut = /abort|timeout/i.test(message);
    return {
      status: timedOut ? "timeout" : "failed",
      output: "",
      error: timedOut ? `超时(${c.timeoutMs / 1000}s)` : message,
    };
  }
}

export async function runEvalSuite(
  supabase: SupabaseClient,
  input: {
    userId: string;
    cookieHeader: string;
    versionSha: string;
    model: string;
  },
): Promise<EvalRunResult> {
  // 内置 20 条(随版本走 git)+ 反馈飞轮长出来的用例(表)
  const dynamic = await loadDynamicCases(supabase, input.userId);
  const allCases = [...EVAL_CASES, ...dynamic];

  const { data: run, error: runError } = await supabase
    .from("eval_runs")
    .insert({
      status: "running",
      version_sha: input.versionSha,
      model: input.model,
      total_cases: allCases.length,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (runError || !run) {
    throw new Error(`无法创建评测运行:${runError?.message ?? "未知错误"}`);
  }

  const records: EvalCaseRecord[] = [];
  const budgetDeadline = Date.now() + EVAL_BUDGET_MS;

  for (const c of allCases) {
    if (Date.now() > budgetDeadline) {
      records.push({
        key: c.key,
        name: c.name,
        status: "skipped",
        output: "",
        error: "预算耗尽,未执行",
        durationMs: 0,
      });
      continue;
    }
    const started = Date.now();
    const result = await runOneCase(c, input.cookieHeader);
    records.push({
      key: c.key,
      name: c.name,
      status: result.status,
      output: result.output.slice(0, 2000),
      error: result.error,
      durationMs: Date.now() - started,
    });
  }

  const passed = records.filter((r) => r.status === "passed").length;
  const failed = records.filter((r) => r.status === "failed" || r.status === "timeout").length;
  const skipped = records.filter((r) => r.status === "skipped").length;
  const ran = passed + failed;
  const status = skipped > 0 ? "partial" : "completed";
  const passRate = ran > 0 ? Math.round((passed / ran) * 100) / 100 : 0;

  await supabase
    .from("eval_runs")
    .update({
      status,
      passed,
      failed,
      skipped,
      pass_rate: passRate,
      finished_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  for (const r of records) {
    await supabase.from("eval_run_cases").insert({
      run_id: run.id,
      case_key: r.key,
      case_name: r.name,
      status: r.status,
      output: r.output || null,
      error: r.error,
      duration_ms: r.durationMs,
    });
  }

  return {
    summary: { status, total: records.length, passed, failed, skipped, passRate },
    records,
  };
}
