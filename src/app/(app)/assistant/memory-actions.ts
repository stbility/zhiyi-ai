"use server";

import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { saveMemory } from "@/lib/db/memories";

/**
 * 沉淀记忆 —— 五条闭环的最后一环。
 *
 * 用户对一条回答点「记住」:消息内容存成一条记忆,
 * 在后续对话里被召回。与反馈 (feedback-actions) 的区别:
 * 反馈是「这条回答好不好」,记忆是「这个事实/偏好要长期记住」。
 * 一条回答可以两个都有,也可以只有其一。
 */

export interface MemoryActionState {
  ok?: string;
  error?: string;
}

const schema = z.object({
  messageId: z.string().uuid(),
  category: z.enum(["fact", "preference", "convention", "knowledge", "persona"]),
  scope: z.enum(["organization", "user"]).optional(),
  customText: z.string().trim().max(100_000).optional(),
});

export async function memorizeMessage(
  _prev: MemoryActionState,
  formData: FormData,
): Promise<MemoryActionState> {
  const parsed = schema.safeParse({
    messageId: formData.get("messageId"),
    category: formData.get("category"),
    scope: formData.get("scope") || undefined,
    customText: formData.get("customText") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const result = await saveMemory(supabase, parsed.data);
  if (!result.ok) return { error: result.error };

  return {
    ok:
      parsed.data.category === "fact"
        ? "已沉淀为记忆,后续对话会召回它。"
        : `已沉淀为「${parsed.data.category}」记忆,后续对话会召回它。`,
  };
}

// 记忆管理页的删除/召回开关动作 —— 页面建好后接线,这里先定义契约
export async function removeMemoryAction(
  _prev: MemoryActionState,
  formData: FormData,
): Promise<MemoryActionState> {
  const memoryId = z
    .string()
    .uuid()
    .safeParse(formData.get("memoryId"));
  if (!memoryId.success) return { error: "记忆标识无效。" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { deleteMemory } = await import("@/lib/db/memories");
  const result = await deleteMemory(supabase, memoryId.data);
  if (!result.ok) return { error: result.error };
  return { ok: "已删除。" };
}

export async function toggleMemoryRecallAction(
  _prev: MemoryActionState,
  formData: FormData,
): Promise<MemoryActionState> {
  const memoryId = z
    .string()
    .uuid()
    .safeParse(formData.get("memoryId"));
  const enabled = z
    .enum(["true", "false"])
    .safeParse(formData.get("enabled"));
  if (!memoryId.success || !enabled.success) return { error: "参数无效。" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { setMemoryRecall } = await import("@/lib/db/memories");
  const result = await setMemoryRecall(
    supabase,
    memoryId.data,
    enabled.data === "true",
  );
  if (!result.ok) return { error: result.error };
  return { ok: enabled.data === "true" ? "已开启召回。" : "已暂停召回。" };
}
