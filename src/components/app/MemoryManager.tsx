"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { MemoryCard } from "@/components/memory/MemoryCard";
import type { MemorySource } from "@/components/memory/MemorySourceBadge";
import { deleteMemory, toggleMemoryRecall } from "@/app/(app)/memory/actions";

export interface MemoryRow {
  readonly id: string;
  readonly categoryLabel: string;
  readonly content: string;
  readonly source: MemorySource;
  readonly confidence: number | null;
  readonly recallEnabled: boolean;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  /** 是否是当前登录用户创建的(只有自己的才能开关召回/删除,RLS 限定) */
  readonly mine: boolean;
}

function formatTime(iso: string | null): string {
  if (!iso) return "从未";
  try {
    return new Date(iso).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function MemoryManager({ memories }: { memories: readonly MemoryRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function handleToggle(id: string, enabled: boolean) {
    setPending(id);
    setError(null);
    const result = await toggleMemoryRecall(id, enabled);
    if (result.error) setError(result.error);
    setPending(null);
    startTransition(() => router.refresh());
  }

  async function handleDelete(id: string) {
    setPending(id);
    setError(null);
    const result = await deleteMemory(id);
    if (result.error) setError(result.error);
    setPending(null);
    startTransition(() => router.refresh());
  }

  if (memories.length === 0) {
    return (
      <div className="border-border-default rounded-control text-fg-secondary font-zh text-caption border border-dashed p-6">
        还没有记忆。智能体在运行中沉淀的、你确认过的内容会出现在这里。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control font-zh text-caption p-3">
          {error}
        </p>
      )}

      {memories.map((row) => (
        <MemoryCard
          key={row.id}
          category={row.categoryLabel}
          content={row.content}
          source={row.source}
          createdAt={formatTime(row.createdAt)}
          lastUsedAt={formatTime(row.lastUsedAt)}
          confidence={
            row.confidence !== null ? Math.round(row.confidence * 100) : undefined
          }
          recallEnabled={row.recallEnabled}
          // 只有本人创建的记忆才给操作回调 —— 与 RLS(update/delete 限创建者)一致,
          // 不渲染点了必然失败的按钮。
          onToggleRecall={
            row.mine && pending !== row.id
              ? (enabled) => void handleToggle(row.id, enabled)
              : undefined
          }
          onDelete={
            row.mine && pending !== row.id
              ? () => void handleDelete(row.id)
              : undefined
          }
        />
      ))}
    </div>
  );
}
