"use client";

import { useState } from "react";
import { useActionState } from "react";

import { Button, StatusLabel } from "@/components/primitives";
import { startEval, syncFeedbackCases } from "@/app/(app)/settings/eval/actions";
import type { EvalCase } from "@/lib/eval/cases";

export interface EvalRunRow {
  readonly id: string;
  readonly status: "running" | "completed" | "partial";
  readonly versionSha: string;
  readonly model: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly passRate: number;
  readonly startedAt: string;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function EvalPanel({
  cases,
  runs,
}: {
  cases: readonly EvalCase[];
  runs: readonly EvalRunRow[];
}) {
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [state, action, running] = useActionState(startEval, undefined);
  const [syncState, syncAction, syncing] = useActionState(syncFeedbackCases, undefined);

  // 可复现性对比:同版本最近两次运行
  const sameVersionPairs: { version: string; a: EvalRunRow; b: EvalRunRow }[] = [];
  {
    const byVersion = new Map<string, EvalRunRow[]>();
    for (const r of runs) {
      const list = byVersion.get(r.versionSha) ?? [];
      list.push(r);
      byVersion.set(r.versionSha, list);
    }
    for (const [version, list] of byVersion) {
      if (list.length >= 2 && list[0] && list[1]) {
        sameVersionPairs.push({ version, a: list[0], b: list[1] });
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <form action={action}>
          <Button size="sm" type="submit" disabled={running}>
            {running ? "评测运行中(预算内尽量跑完)…" : "一键跑评测"}
          </Button>
        </form>
        <form action={syncAction}>
          <Button size="sm" variant="secondary" type="submit" disabled={syncing}>
            {syncing ? "同步中…" : "从反馈改写同步用例"}
          </Button>
        </form>
        {state?.error && <p className="text-error text-caption">{state.error}</p>}
        {state?.ok && <p className="text-success text-caption">{state.ok}</p>}
        {syncState?.error && <p className="text-error text-caption">{syncState.error}</p>}
        {syncState?.ok && <p className="text-success text-caption">{syncState.ok}</p>}
      </div>

      {/* 用例集 */}
      <section className="bg-surface-2 border-border-default rounded-card font-zh border p-4">
        <h3 className="text-fg text-body font-medium mb-2">
          用例集({cases.length} 条,内置 + 反馈沉淀)
        </h3>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-caption">
            <thead>
              <tr className="text-fg-tertiary text-left">
                <th className="py-1 pr-3">键</th>
                <th className="py-1 pr-3">名称</th>
                <th className="py-1 pr-3">来源</th>
                <th className="py-1 pr-3">判定(确定性)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {cases.map((c) => (
                <tr key={c.key}>
                  <td className="py-1.5 pr-3 font-mono">{c.key}</td>
                  <td className="py-1.5 pr-3">{c.name}</td>
                  <td className="py-1.5 pr-3">
                    <StatusLabel tone={c.source === "feedback" ? "warning" : "neutral"}>
                      {c.source === "feedback" ? "来自反馈" : "内置"}
                    </StatusLabel>
                  </td>
                  <td className="text-fg-tertiary py-1.5 pr-3">
                    {c.mustContain?.join(" / ") ??
                      c.mustContainAny?.join(" / ") ??
                      ""}
                    {c.mustNotContain?.length
                      ? `,不得含:${c.mustNotContain.join(" / ")}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 历史运行 */}
      <section className="bg-surface-2 border-border-default rounded-card font-zh border p-4">
        <h3 className="text-fg text-body font-medium mb-2">历史运行</h3>
        {runs.length === 0 ? (
          <p className="text-fg-tertiary text-caption">还没有运行。点上面的按钮跑第一次。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {runs.map((r) => (
              <div key={r.id} className="border-border-default rounded-control border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-caption">{r.versionSha}</span>
                  <StatusLabel
                    tone={r.status === "partial" ? "warning" : r.passRate >= 0.9 ? "success" : "neutral"}
                  >
                    {r.status === "partial" ? "部分完成" : "完成"}
                  </StatusLabel>
                  <StatusLabel tone="neutral">
                    {`通过 ${r.passed}/${r.total - r.skipped}${r.skipped > 0 ? `(+${r.skipped} 跳过)` : ""}`}
                  </StatusLabel>
                  <span className="text-fg-tertiary text-label">
                    {formatTime(r.startedAt)} · {r.model}
                  </span>
                  <button
                    type="button"
                    className="text-brand text-label ml-auto"
                    onClick={() => setExpandedRun(expandedRun === r.id ? null : r.id)}
                  >
                    {expandedRun === r.id ? "收起" : "详情"}
                  </button>
                </div>
                {expandedRun === r.id && (
                  <p className="text-fg-secondary text-caption mt-2">
                    逐条结果存于 eval_run_cases(run_id={r.id.slice(0, 8)}…),点击上方按钮重跑以生成对比。
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 可复现性 */}
      {sameVersionPairs.length > 0 && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-4">
          <h3 className="text-fg text-body font-medium mb-1">可复现性对比(同版本连跑)</h3>
          <p className="text-fg-tertiary text-caption mb-2">
            检查器是确定性的;差异来自 LLM 输出概率性 —— 如实展示,不粉饰。
          </p>
          {sameVersionPairs.map(({ version, a, b }) => (
            <div key={version} className="border-border-default rounded-control border p-3">
              <p className="text-label mb-1">
                <span className="font-mono">{version}</span> · 第一次 {a.passed}/{a.total - a.skipped}
                ↔ 第二次 {b.passed}/{b.total - b.skipped}
              </p>
              <p className="text-fg-secondary text-caption">
                通过率一致 = 检查器可复现;不一致 = 该用例对模型输出敏感,适合作为调优对象。
              </p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
