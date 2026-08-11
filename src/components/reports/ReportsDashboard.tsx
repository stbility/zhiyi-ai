"use client";

import { Badge } from "@/components/primitives/Badge";
import { StatusLabel } from "@/components/primitives/StatusLabel";
import { cn } from "@/lib/cn";

export interface EvalRunRow {
  readonly id: string;
  readonly status: string;
  readonly versionSha: string;
  readonly model: string;
  readonly totalCases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly passRate: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * 报表仪表盘(阶段 7,2026-08-11)。
 *
 * 数据源:eval_runs(评测运行结果)。展示:
 *   1. 汇总卡:总运行次数、平均通过率、最近一次通过率
 *   2. 趋势表:每次运行的通过率/用例数/模型/版本
 *
 * 真实数据原则:无记录时如实显示空态,不画假图表、不造样例数据。
 * 全部样式走设计系统 token,不拼接、不手抄类名。
 */

function fmtRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function fmtDate(iso: string): string {
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

export function ReportsDashboard({ runs }: { runs: readonly EvalRunRow[] }) {
  const completed = runs.filter((r) => r.status === "completed");
  const avgRate =
    completed.length > 0
      ? completed.reduce((sum, r) => sum + r.passRate, 0) / completed.length
      : 0;
  const latest = completed[0];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-fg text-h2 font-zh font-semibold">报表</h2>
        <p className="text-fg-secondary font-zh text-caption mt-1">
          评测运行趋势:同一版本连跑通过率对比,如实反映模型在最新代码上的表现。
        </p>
      </div>

      {runs.length === 0 ? (
        <div className="border-border-default bg-surface-2 rounded-panel border p-8 text-center">
          <p className="text-fg-secondary font-zh text-caption">
            还没有评测运行记录。前往「评测」页面跑一次评测集,结果会出现在这里。
          </p>
        </div>
      ) : (
        <>
          {/* 汇总卡 */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="border-border-default bg-surface-2 rounded-panel border p-5">
              <p className="text-fg-tertiary font-zh text-caption">总运行次数</p>
              <p className="text-fg text-h3 font-zh mt-1 font-semibold">
                {runs.length}
              </p>
            </div>
            <div className="border-border-default bg-surface-2 rounded-panel border p-5">
              <p className="text-fg-tertiary font-zh text-caption">平均通过率</p>
              <p className="text-fg text-h3 font-zh mt-1 font-semibold">
                {completed.length > 0 ? fmtRate(avgRate) : "—"}
              </p>
            </div>
            <div className="border-border-default bg-surface-2 rounded-panel border p-5">
              <p className="text-fg-tertiary font-zh text-caption">最近一次通过率</p>
              <p className="text-fg text-h3 font-zh mt-1 font-semibold">
                {latest ? fmtRate(latest.passRate) : "—"}
              </p>
            </div>
          </div>

          {/* 趋势表 */}
          <div className="border-border-default bg-surface-2 overflow-x-auto rounded-panel border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-border-default text-fg-tertiary font-zh border-b text-caption">
                  <th className="px-4 py-3 font-medium">时间</th>
                  <th className="px-4 py-3 font-medium">通过率</th>
                  <th className="px-4 py-3 font-medium">通过/总数</th>
                  <th className="px-4 py-3 font-medium">模型</th>
                  <th className="px-4 py-3 font-medium">版本</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-border-default hover:bg-surface-3 border-b last:border-b-0"
                  >
                    <td className="text-fg-secondary font-zh px-4 py-3 whitespace-nowrap">
                      {fmtDate(run.startedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "font-zh font-semibold",
                          run.passRate >= 0.8
                            ? "text-success"
                            : run.passRate >= 0.5
                              ? "text-warning"
                              : "text-danger",
                        )}
                      >
                        {fmtRate(run.passRate)}
                      </span>
                    </td>
                    <td className="text-fg-secondary font-zh px-4 py-3">
                      {run.passed}/{run.totalCases}
                      {run.skipped > 0 && ` (跳过 ${run.skipped})`}
                    </td>
                    <td className="text-fg font-zh max-w-40 truncate px-4 py-3">
                      {run.model || "—"}
                    </td>
                    <td className="text-fg-tertiary font-zh px-4 py-3 font-mono text-xs">
                      {run.versionSha.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      {run.status === "completed" ? (
                        <Badge tone="success">完成</Badge>
                      ) : run.status === "partial" ? (
                        <Badge tone="warning">部分</Badge>
                      ) : (
                        <StatusLabel tone="warning">运行中</StatusLabel>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
