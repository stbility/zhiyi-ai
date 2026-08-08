import type { Metadata } from "next";

import { EvalPanel, type EvalRunRow } from "@/components/app/EvalPanel";
import { EVAL_CASES, dbRowToEvalCase, type EvalCase } from "@/lib/eval/cases";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "评测 · 智一 AI" };
export const dynamic = "force-dynamic";
// 20 条用例串行跑,预留整个函数预算
export const maxDuration = 300;

export default async function EvalPage() {
  const supabase = await createSupabaseServerClient();

  let runs: EvalRunRow[] = [];
  let dynamicCases: EvalCase[] = [];
  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const { data: caseRows } = await supabase
        .from("eval_cases")
        .select("key, name, prompt, must_contain, must_contain_any, must_not_contain, timeout_ms")
        .eq("created_by", user.id)
        .eq("enabled", true)
        .order("created_at", { ascending: false });
      dynamicCases = ((caseRows ?? []) as unknown[]).map((r) =>
        dbRowToEvalCase(r as never),
      );

      const { data } = await supabase
        .from("eval_runs")
        .select("id, status, version_sha, model, total_cases, passed, failed, skipped, pass_rate, started_at, finished_at")
        .eq("created_by", user.id)
        .order("created_at", { ascending: false })
        .limit(10);

      runs = ((data ?? []) as unknown[]).map((row) => {
        const r = row as {
          id: string;
          status: string;
          version_sha: string;
          model: string;
          total_cases: number;
          passed: number;
          failed: number;
          skipped: number;
          pass_rate: number;
          started_at: string;
          finished_at: string | null;
        };
        return {
          id: r.id,
          status: r.status as "running" | "completed" | "partial",
          versionSha: r.version_sha,
          model: r.model,
          total: r.total_cases,
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
          passRate: r.pass_rate,
          startedAt: r.started_at,
        };
      });
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">评测</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          20 条用例一键跑完,走真实智能体链路(模型解析、额度、记忆与知识库注入),
          结果落 eval_runs。检查器确定性判定;同一版本连跑两次可对比复现性。
        </p>
      </header>

      <EvalPanel cases={[...EVAL_CASES, ...dynamicCases]} runs={runs} />
    </div>
  );
}
