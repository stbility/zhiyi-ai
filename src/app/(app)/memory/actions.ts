"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * AI 记忆管理页的服务端动作(直接签名,供 MemoryCard 回调调用)。
 *
 * 记忆的增(沉淀)发生在智能体运行时;这里只做管理侧的两个动作:
 * 开关召回、删除。RLS(0028)限定 update/delete 仅限记忆创建者本人 ——
 * 服务端不额外放行,数据库的判定就是最终判定。
 */

export interface MemoryActionResult {
  readonly ok?: string;
  readonly error?: string;
}

const idSchema = z.string().uuid("标识无效");

export async function toggleMemoryRecall(
  id: string,
  enabled: boolean,
): Promise<MemoryActionResult> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("memories")
    .update(
      {
        recall_enabled: enabled,
        updated_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("id", parsed.data);

  if (error) return { error: error.message };
  // 0 行被改 = RLS 拦下(只能操作自己的记忆)或记录不存在 —— 如实说明,
  // 不能给一句「已更新」而实际什么都没发生。
  if ((count ?? 0) === 0) {
    return { error: "只能操作自己的记忆,或该记忆已不存在。" };
  }

  revalidatePath("/memory");
  return { ok: enabled ? "已开启召回。" : "已关闭召回(记忆保留,随时可重新开启)。" };
}

export async function deleteMemory(id: string): Promise<MemoryActionResult> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("memories")
    .delete({ count: "exact" })
    .eq("id", parsed.data);
  if (error) return { error: error.message };
  if ((count ?? 0) === 0) {
    return { error: "只能删除自己的记忆,或该记忆已不存在。" };
  }

  revalidatePath("/memory");
  return { ok: "已删除。" };
}
