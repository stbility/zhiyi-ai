import type { Metadata } from "next";

import { ReportsDashboard, type EvalRunRow } from "@/components/reports/ReportsDashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "报表 · 智一 AI" };
export const dynamic = "force-dynamic";

/**
 * 报表页(阶段 7 最后缺口,2026-08-11)。
 *
 * 当前数据源:评测运行结果(eval_runs)—— 这是系统里最有报表价值
 * 的真实数据:每次跑评测集记一行(通过率/用例数/模型/版本),连跑对比
 * 即「这个模型在最新版本上表现如何」的趋势。
 *
 * 真实数据原则:只展示库里真实存在的行,不造样例、不填占位。
 * 尚无评测运行记录时如实显示空态,不画假图表。
 */

async function loadEvalRuns(userId: string): Promise<EvalRunRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("eval_runs")
    .select(
      "id, status, version_sha, model, total_cases, passed, failed, skipped, pass_rate, started_at, finished_at",
    )
    .eq("created_by", userId)
    .order("started_at", { ascending: false })
    .limit(50);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    status: row.status as string,
    versionSha: row.version_sha as string,
    model: (row.model as string) ?? "",
    totalCases: (row.total_cases as number) ?? 0,
    passed: (row.passed as number) ?? 0,
    failed: (row.failed as number) ?? 0,
    skipped: (row.skipped as number) ?? 0,
    passRate: (row.pass_rate as number) ?? 0,
    startedAt: (row.started_at as string) ?? "",
    finishedAt: (row.finished_at as string | null) ?? null,
  }));
}

export default async function ReportsPage() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">报表</h2>
        <p className="text-fg-secondary font-zh text-caption">
          认证服务未配置,无法加载数据。
        </p>
      </main>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">报表</h2>
        <p className="text-fg-secondary font-zh text-caption">请先登录。</p>
      </main>
    );
  }

  const runs = await loadEvalRuns(user.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <ReportsDashboard runs={runs} />
    </main>
  );
}
