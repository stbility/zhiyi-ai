"use client";

import { useActionState, useEffect, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Button } from "@/components/primitives/Button";
import {
  SubmitIconButton,
  SubmitTextButton,
} from "@/components/primitives/SubmitButton";
import {
  deleteWorkspace,
  deleteWorkspaceFile,
  type WorkspaceActionState,
} from "@/app/(app)/workspace/actions";
import { cn } from "@/lib/cn";
import { decidePreview, pickDefaultFile } from "@/lib/workspace/preview";
import { buildProjectPreview } from "@/lib/workspace/bundle";
import { markdownDocument } from "@/lib/workspace/markdown";

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
  // 默认落在能看到效果的入口上,而不是字母序第一个(往往是 README)
  const [openPath, setOpenPath] = useState<string | null>(() =>
    pickDefaultFile(files.map((f) => f.path)),
  );
  /** 预览还是源码。默认预览 —— 用户要的是看到效果,不是读代码 */
  const [mode, setMode] = useState<"preview" | "source">("preview");
  /**
   * 全屏阅读。
   *
   * 420px 高的预览框放一份周报根本读不完,得在小窗里一直滚 ——
   * 用户的原话是「工作区输出框无法完整读取内容」。
   *
   * 为什么不是「在新标签页打开」:那需要把内容变成 blob: 或 data: URL,
   * 而 blob 继承创建它的源 —— 等于让模型生成的 HTML 与脚本跑在
   * 我们自己的域上,能读到登录态 Cookie 与 localStorage。
   * 全屏用的还是同一个 sandbox iframe,隔离没有任何放松,
   * 只是把可视区域给足。真要脱离浏览器看,下方有「存为可运行页面」,
   * 那是 file:// 独立源,同样安全。
   */
  const [fullscreen, setFullscreen] = useState(false);
  // 全屏层是覆盖全屏的,必须能用 Esc 退出 —— 否则键盘用户被困在里面,
  // 鼠标用户也会下意识按 Esc 然后发现没反应
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

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

  /**
   * 送进 iframe 的文档。按类别现做:
   *   project —— 整个工作区打包成能现场编译的页面
   *   markdown —— 排版后的文档
   *   html / svg —— 文件本身就是可渲染文档
   */
  const previewDoc = (() => {
    if (!open || !preview) return null;
    switch (preview.kind) {
      case "project":
        return buildProjectPreview(open.content, files).html;
      case "markdown":
        return markdownDocument(open.content);
      case "html":
      case "svg":
        return open.content;
      default:
        return null;
    }
  })();

  /**
   * 沙箱权限按需给足,但绝不给 allow-same-origin。
   *
   * 它和 allow-scripts 一起加等于没有沙箱 —— 模型生成的代码就能读我们的
   * Cookie 与 localStorage。内容永远当不可信代码对待。
   * Markdown 与 SVG 不需要脚本,连 allow-scripts 也不给。
   */
  const sandbox =
    preview?.kind === "markdown" || preview?.kind === "svg"
      ? // 必须给 allow-popups,否则 <a target="_blank"> 在沙箱里被直接吞掉 ——
        // README 里的链接一个都点不开,用户以为链接生成错了。
        // 配上 allow-popups-to-escape-sandbox,新开的页面不再继承沙箱限制,
        // 否则打开的外部网站自己也跑不起来。
        // 仍然不给 allow-same-origin 与 allow-scripts:能跳转,但碰不到我们的
        // Cookie,也执行不了脚本。
        "allow-popups allow-popups-to-escape-sandbox"
      : "allow-scripts allow-popups allow-popups-to-escape-sandbox";

  /**
   * 把可运行页面存成本地文件。
   *
   * 存盘而不是 window.open(blob):blob URL 继承创建者的源,直接开新标签
   * 等于让模型生成的代码跑在我们自己的域上,能碰到登录态。存成文件后
   * 用浏览器打开走的是 file:// 独立源,天然隔离。
   */
  function downloadRunnable() {
    if (!open || previewDoc === null) return;
    const url = URL.createObjectURL(
      new Blob([previewDoc], { type: "text/html;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(open.path.split("/").pop() ?? "preview").replace(/\.[^.]+$/, "")}-可运行.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

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
            <SubmitTextButton
              className="text-fg-tertiary hover:text-error text-label"
              title="删除整个工作区"
            >
              删除工作区
            </SubmitTextButton>
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
                  {previewDoc !== null && (
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

                  {previewDoc !== null && mode === "preview" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setFullscreen(true)}
                      title="全屏阅读(Esc 退出)"
                    >
                      <Icon name="externalLink" size={14} />
                      全屏
                    </Button>
                  )}

                  {preview?.kind === "project" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={downloadRunnable}
                      title="存成单个 HTML,用浏览器打开即可运行,不需要 npm 与构建"
                    >
                      存为可运行页面
                    </Button>
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
                    <SubmitIconButton
                      icon="x"
                      size={13}
                      aria-label={`删除 ${open.path}`}
                      title="删除这个文件"
                      className="text-fg-tertiary hover:text-error p-1"
                    />
                  </form>
                </div>

                {previewDoc !== null && mode === "preview" ? (
                  <iframe
                    // key 带上路径:换文件时必须重建 iframe,
                    // 否则上一个页面的脚本还活着,状态会串
                    key={open.path}
                    title={`${open.path} 预览`}
                    srcDoc={previewDoc}
                    sandbox={sandbox}
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

      {/* 全屏阅读层。用的是同一份 previewDoc 与同一套 sandbox,
          隔离强度不变,只是把高度给足。 */}
      {fullscreen && open && previewDoc !== null && (
        <div
          className="bg-canvas/90 fixed inset-0 z-100 flex flex-col p-4 md:p-8"
          role="dialog"
          aria-modal
          aria-label={`${open.path} 全屏阅读`}
        >
          <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
            <span className="text-fg-secondary text-label min-w-0 flex-1 truncate font-mono">
              {open.path}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setFullscreen(false)}
            >
              <Icon name="x" size={14} />
              退出全屏
            </Button>
          </div>
          <iframe
            key={`fs-${open.path}`}
            title={`${open.path} 全屏预览`}
            srcDoc={previewDoc}
            sandbox={sandbox}
            className="bg-paper-surface rounded-card min-h-0 w-full flex-1 border-0"
          />
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
