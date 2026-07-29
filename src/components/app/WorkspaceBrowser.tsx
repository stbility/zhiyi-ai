"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import {
  deleteWorkspace,
  deleteWorkspaceFile,
  type WorkspaceActionState,
} from "@/app/(app)/workspace/actions";
import { cn } from "@/lib/cn";
import { decidePreview } from "@/lib/workspace/preview";

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
  id,
  name,
  files,
}: {
  id: string;
  name: string;
  files: readonly WorkspaceFile[];
}) {
  const [openPath, setOpenPath] = useState<string | null>(
    files[0]?.path ?? null,
  );
  /** 预览还是源码。默认预览 —— 用户要的是看到效果,不是读代码 */
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [, deleteFileAction] = useActionState<WorkspaceActionState, FormData>(
    deleteWorkspaceFile,
    {},
  );
  const [, deleteWorkspaceAction] = useActionState<
    WorkspaceActionState,
    FormData
  >(deleteWorkspace, {});

  const open = files.find((f) => f.path === openPath) ?? null;
  const preview = open
    ? decidePreview(open.path, open.content, files.map((f) => f.path))
    : null;

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
        <div className="flex items-center gap-3">
          <span className="text-fg-tertiary text-label">
            {files.length} 个文件
          </span>
          <form action={deleteWorkspaceAction}>
            <input type="hidden" name="workspaceId" value={id} />
            <button
              type="submit"
              className="text-fg-tertiary hover:text-error text-label cursor-pointer"
              title="删除整个工作区"
            >
              删除工作区
            </button>
          </form>
        </div>
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
                  <span className="text-fg-secondary text-label min-w-0 flex-1 truncate font-mono">
                    {open.path}
                  </span>

                  {/* 能预览就默认给预览 —— 用户要看的是效果,不是代码 */}
                  {preview?.kind === "html" && (
                    <div className="border-border-default rounded-control flex overflow-hidden border">
                      {(["preview", "source"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMode(m)}
                          className={cn(
                            "text-label cursor-pointer px-2 py-1",
                            "transition-colors duration-[var(--duration-hover)] ease-standard",
                            mode === m
                              ? "bg-brand-tint text-brand"
                              : "text-fg-tertiary hover:text-fg-secondary",
                          )}
                        >
                          {m === "preview" ? "预览" : "源码"}
                        </button>
                      ))}
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => downloadOne(open)}
                  >
                    下载
                  </Button>

                  <form action={deleteFileAction}>
                    <input type="hidden" name="workspaceId" value={id} />
                    <input type="hidden" name="path" value={open.path} />
                    <button
                      type="submit"
                      aria-label={`删除 ${open.path}`}
                      title="删除这个文件"
                      className="text-fg-tertiary hover:text-error cursor-pointer p-1"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </form>
                </div>

                {preview?.kind === "html" && mode === "preview" ? (
                  /*
                   * 沙箱只给 allow-scripts,**不给** allow-same-origin。
                   * 这两个一起加等于没有沙箱 —— 页面就能读我们的 Cookie 与
                   * localStorage。内容是模型生成的,必须当成不可信代码对待。
                   */
                  <iframe
                    title={`${open.path} 预览`}
                    srcDoc={open.content}
                    sandbox="allow-scripts"
                    className="bg-paper-surface h-[420px] w-full border-0"
                  />
                ) : (
                  <>
                    {preview?.reason && (
                      <p className="text-fg-tertiary text-label border-divider border-b px-3 py-2">
                        {preview.reason}
                      </p>
                    )}
                    <pre className="text-fg-secondary max-h-[420px] overflow-auto p-3 text-[12px] leading-[1.6]">
                      {open.content}
                    </pre>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" onClick={downloadAll}>
            <Icon name="download" size={14} />
            下载全部
          </Button>
        </div>
      )}
    </section>
  );
}
