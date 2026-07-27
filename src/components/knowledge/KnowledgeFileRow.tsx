import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

/**
 * 知识库文件行。
 *
 * 状态必须如实反映解析管线的真实进度 —— 解析失败、格式不支持都要显式展示,
 * 不得静默隐藏或伪装为可用。
 */
export const KNOWLEDGE_FILE_STATUSES = [
  "uploading",
  "parsing",
  "indexing",
  "ready",
  "failed",
  "unsupported",
] as const;

export type KnowledgeFileStatus = (typeof KNOWLEDGE_FILE_STATUSES)[number];

type Tone = "brand" | "success" | "info" | "neutral" | "error";

const STATUS: Record<KnowledgeFileStatus, { label: string; tone: Tone }> = {
  uploading: { label: "上传中", tone: "info" },
  parsing: { label: "解析中", tone: "info" },
  indexing: { label: "建立索引中", tone: "brand" },
  ready: { label: "可用", tone: "success" },
  failed: { label: "解析失败", tone: "error" },
  unsupported: { label: "不支持格式", tone: "neutral" },
};

const TONE_CLASS: Record<Tone, string> = {
  brand: "bg-brand-tint text-brand",
  success: "bg-success-tint text-success",
  info: "bg-info-tint text-info",
  neutral: "bg-surface-3 text-fg-tertiary",
  error: "bg-error-tint text-error",
};

export interface KnowledgeFileRowProps {
  name: string;
  type: string;
  size: string;
  status?: KnowledgeFileStatus | undefined;
  linkedWorkflows?: number | undefined;
  tags?: readonly string[] | undefined;
  onOpen?: (() => void) | undefined;
  className?: string | undefined;
}

export function KnowledgeFileRow({
  name,
  type,
  size,
  status = "ready",
  linkedWorkflows = 0,
  tags = [],
  onOpen,
  className,
}: KnowledgeFileRowProps) {
  const meta = STATUS[status];
  const interactive = typeof onOpen === "function";

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon name="knowledge" size={16} className="text-fg-tertiary shrink-0" />
        <span className="min-w-0">
          <span className="text-fg block truncate text-[14px]">{name}</span>
          {tags.length > 0 && (
            <span className="mt-[3px] flex gap-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="text-fg-tertiary bg-surface-3 rounded-tag px-1.5 py-px text-[11px]"
                >
                  {tag}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>

      <span className="text-fg-tertiary text-label font-mono">{type}</span>
      <span className="text-fg-tertiary text-label">{size}</span>

      <span
        className={cn(
          "rounded-tag inline-flex w-fit items-center gap-[5px] px-2 py-[3px] text-[11px]",
          TONE_CLASS[meta.tone],
        )}
      >
        {meta.label}
      </span>

      <span className="text-fg-tertiary text-label">
        {linkedWorkflows > 0 ? `${linkedWorkflows} 个工作流` : "—"}
      </span>
    </>
  );

  const classes = cn(
    "border-divider font-zh grid grid-cols-[1fr_90px_110px_130px_110px] items-center gap-3 border-b px-3.5 py-2.5 text-left",
    interactive &&
      "hover:bg-surface-2 cursor-pointer transition-colors duration-[var(--duration-hover)] ease-standard",
    className,
  );

  if (interactive) {
    return (
      <button type="button" onClick={onOpen} className={classes}>
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}
