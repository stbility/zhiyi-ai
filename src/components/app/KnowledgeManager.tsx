"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useActionState } from "react";

import { KnowledgeFileRow, type KnowledgeFileStatus } from "@/components/knowledge/KnowledgeFileRow";
import { KnowledgePreview } from "@/components/knowledge/KnowledgePreview";
import { Button, IconButton } from "@/components/primitives";
import { Icon } from "@/components/icons/Icon";
import { deleteKnowledgeFile, uploadKnowledgeFile } from "@/app/(app)/knowledge/actions";
import type { KnowledgeFileType } from "@/lib/knowledge/parse";

export interface KnowledgeRow {
  readonly id: string;
  readonly name: string;
  readonly fileType: KnowledgeFileType;
  readonly sizeBytes: number;
  readonly status: KnowledgeFileStatus;
  readonly error: string | null;
  readonly mine: boolean;
  readonly createdAt: string;
  readonly contentText: string;
}

const TYPE_LABEL: Record<KnowledgeFileType, string> = {
  pdf: "PDF",
  docx: "DOCX",
  md: "MD",
  txt: "TXT",
  other: "文件",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function KnowledgeManager({
  files,
  initialQuery,
}: {
  files: readonly KnowledgeRow[];
  initialQuery: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [uploadState, uploadAction, uploading] = useActionState(
    uploadKnowledgeFile,
    undefined,
  );

  const selected = files.find((f) => f.id === selectedId) ?? null;

  async function handleDelete(id: string) {
    setPending(id);
    setDeleteError(null);
    const result = await deleteKnowledgeFile(id);
    if (result.error) setDeleteError(result.error);
    setPending(null);
    startTransition(() => router.refresh());
  }

  function handleSearch() {
    const q = query.trim();
    void router.push(q ? `/knowledge?q=${encodeURIComponent(q)}` : "/knowledge");
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        {/* 上传 */}
        <form
          action={uploadAction}
          className="bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-2 border p-4"
        >
          <label className="text-fg-secondary text-caption">
            上传文档(pdf / docx / md / txt,≤10MB):
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              name="file"
              accept=".pdf,.docx,.md,.markdown,.txt"
              required
              className="text-fg-secondary text-caption flex-1"
            />
            <Button size="sm" type="submit" disabled={uploading}>
              {uploading ? "解析中…" : "上传并解析"}
            </Button>
          </div>
          {uploadState?.error && (
            <p className="text-error text-caption">{uploadState.error}</p>
          )}
          {uploadState?.ok && (
            <p className="text-success text-caption">{uploadState.ok}</p>
          )}
        </form>

        {/* 检索 */}
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            placeholder="检索文件名称或正文…"
            className="border-border-default bg-surface-2 text-fg text-caption rounded-control font-zh w-full border px-3 py-2 outline-none"
          />
          <Button size="sm" variant="secondary" onClick={handleSearch}>
            检索
          </Button>
        </div>

        {deleteError && (
          <p className="border-error-tint bg-error-tint text-error rounded-control font-zh text-caption p-3">
            {deleteError}
          </p>
        )}

        {files.length === 0 ? (
          <p className="border-border-default rounded-control text-fg-secondary font-zh text-caption border border-dashed p-4">
            {query ? "没有匹配的文件。" : "还没有文档。上传第一份,智能体就能检索它。"}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {files.map((file) => (
              <div key={file.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <KnowledgeFileRow
                    name={file.name}
                    type={TYPE_LABEL[file.fileType]}
                    size={formatSize(file.sizeBytes)}
                    status={file.status}
                    onOpen={() => setSelectedId(file.id)}
                  />
                </div>
                {file.mine && (
                  <IconButton
                    aria-label={`删除 ${file.name}`}
                    disabled={pending !== null}
                    onClick={() => void handleDelete(file.id)}
                    size={30}
                  >
                    <Icon name="trash" size={15} className="text-error" />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 预览 */}
      <div className="min-w-0">
        {selected ? (
          <KnowledgePreview
            title={selected.name}
            updatedAt={new Date(selected.createdAt).toLocaleString("zh-CN")}
          >
            {selected.status === "ready" && selected.contentText ? (
              <pre className="text-fg-secondary whitespace-pre-wrap text-[13px] leading-[1.7]">
                {selected.contentText.slice(0, 6000)}
              </pre>
            ) : selected.status === "failed" ? (
              <p className="text-error text-caption">
                解析失败:{selected.error ?? "未知错误"}
              </p>
            ) : (
              <p className="text-fg-tertiary text-caption">
                {selected.status === "parsing" || selected.status === "indexing"
                  ? "正在建立索引…"
                  : "尚未就绪。"}
              </p>
            )}
          </KnowledgePreview>
        ) : (
          <div className="border-border-default rounded-panel text-fg-tertiary font-zh border border-dashed p-6 text-center text-caption">
            选择左侧文件查看内容预览
          </div>
        )}
      </div>
    </div>
  );
}
