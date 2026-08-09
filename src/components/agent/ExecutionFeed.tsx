import Link from "next/link";

import { cn } from "@/lib/cn";
import type { McpExecution } from "@/lib/db/executions";

/**
 * 外部智能体(Hermes 等)执行记录流 —— 评审建议第 1 项「执行状态回传」的
 * 展示层:用户在智能体页面看到外部执行器调用了什么工具、耗时、成败、
 * 以及 git_propose_changes 产生的分支与 PR 链接。
 */
export function ExecutionFeed({
  executions,
}: {
  executions: readonly McpExecution[];
}) {
  if (executions.length === 0) {
    return (
      <div className="border-border-default bg-surface-1 rounded-card border p-4">
        <p className="text-fg-secondary font-zh text-caption">
          还没有外部智能体(Hermes / OpenClaw)的执行记录。连接 MCP 后,工作区
          读写、Git 分支与 PR 的每一步都会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-secondary font-zh text-caption">
        最近 {executions.length} 次外部执行(每步工具调用一条,按时间倒序)
      </p>
      <ul className="flex flex-col gap-2">
        {executions.map((run) => {
          const pr =
            typeof run.result_summary?.pull_request_url === "string"
              ? run.result_summary.pull_request_url
              : null;
          const branch =
            typeof run.result_summary?.branch === "string"
              ? run.result_summary.branch
              : null;
          const summary =
            typeof run.result_summary?.text === "string"
              ? run.result_summary.text
              : "";
          return (
            <li
              key={run.id}
              className="border-border-default bg-surface-1 rounded-card border p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      run.status === "ok" ? "bg-success" : "bg-error",
                    )}
                  />
                  <span className="text-fg font-zh text-caption font-medium">
                    {run.tool_name}
                  </span>
                  {branch ? (
                    <span className="text-fg-tertiary font-mono text-caption truncate">
                      分支 {branch}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {pr ? (
                    <Link
                      href={pr}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:text-brand-hover font-zh text-caption"
                    >
                      查看 PR ↗
                    </Link>
                  ) : null}
                  <span className="text-fg-tertiary font-zh text-caption whitespace-nowrap">
                    {run.duration_ms != null
                      ? `${(run.duration_ms / 1000).toFixed(1)}s`
                      : ""}
                    {formatTime(run.created_at)}
                  </span>
                </div>
              </div>
              {run.status === "error" && run.error ? (
                <p className="text-error font-zh text-caption mt-2 break-all">
                  {run.error}
                </p>
              ) : summary ? (
                <p className="text-fg-secondary font-zh text-caption mt-2 line-clamp-2 break-all">
                  {summary}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60_000);
  if (diffMin < 1) return " · 刚刚";
  if (diffMin < 60) return ` · ${diffMin} 分钟前`;
  if (diffMin < 1440) return ` · ${Math.floor(diffMin / 60)} 小时前`;
  return ` · ${d.toLocaleDateString("zh-CN")} ${d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
