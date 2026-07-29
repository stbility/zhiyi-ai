"use client";

import { useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import { cn } from "@/lib/cn";

export interface WorkspaceFile {
  path: string;
  content: string;
  sizeChars: number;
  updatedAt: string;
}

/**
 * 工作区文件浏览。
 *
 * 这个页面存在的意义:让「智能体产出了文件」变成看得见摸得着的东西。
 * 在此之前,模型写的代码全在对话气泡里,用户得手工复制 —— 那不叫自动化。
 */
export function WorkspaceBrowser({
  name,
  files,
}: {
  name: string;
  files: readonly WorkspaceFile[];
}) {
  const [openPath, setOpenPath] = useState<string | null>(
    files[0]?.path ?? null,
  );
  const open = files.find((f) => f.path === openPath) ?? null;

  function downloadAll() {
    // 不引入打包库:把所有文件拼成一份带路径分隔的纯文本。
    // 真正的 zip 打包等接了 Git 推送之后再做 —— 那时候直接推仓库更合适。
    const text = files
      .map((f) => `===== ${f.path} =====\n${f.content}`)
      .join("\n\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "workspace"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadOne(file: WorkspaceFile) {
    const url = URL.createObjectURL(
      new Blob([file.content], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = file.path.split("/").pop() ?? "file.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-fg text-body font-medium">{name}</h3>
        <span className="text-fg-tertiary text-label">
          {files.length} 个文件
        </span>
      </div>

      {files.length === 0 ? (
        <p className="text-fg-tertiary text-caption">这个工作区还没有文件。</p>
      ) : (
        <div className="flex flex-col gap-3 md:flex-row">
          <nav className="flex shrink-0 flex-col gap-0.5 md:w-64">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setOpenPath(f.path)}
                aria-current={f.path === openPath ? "true" : undefined}
                className={cn(
                  "rounded-control flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px]",
                  "transition-colors duration-[var(--duration-hover)] ease-standard",
                  f.path === openPath
                    ? "bg-brand-tint text-brand"
                    : "text-fg-secondary hover:bg-surface-3",
                )}
              >
                <Icon name="book" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {f.path}
                </span>
              </button>
            ))}
          </nav>

          <div className="border-border-default rounded-control min-w-0 flex-1 border">
            {open && (
              <>
                <div className="border-divider flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="text-fg-secondary text-label min-w-0 truncate font-mono">
                    {open.path}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => downloadOne(open)}
                  >
                    下载
                  </Button>
                </div>
                <pre className="text-fg-secondary max-h-[420px] overflow-auto p-3 text-[12px] leading-[1.6]">
                  {open.content}
                </pre>
              </>
            )}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" onClick={downloadAll}>
            <Icon name="upload" size={14} />
            下载全部
          </Button>
        </div>
      )}
    </section>
  );
}
