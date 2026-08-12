import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 结构化日志(阶段 8,2026-08-12)。
 *
 * 落点:public.system_logs(0056)。一行一事件,level 分级,meta 存结构细节。
 * 纪律:**写日志失败绝不影响主链路** —— 日志是旁路,不是业务路径的一部分,
 * 所有错误在此吞掉并交给 console.error(Vercel 平台日志兜底)。
 *
 * 用途:工作流运行、智能体回合、支付回调、Worker 执行的排查留痕,
 * 替代「只能翻 72h 平台日志、不可检索」的现状。
 */

export interface LogEventInput {
  level?: "info" | "warn" | "error";
  event: string;
  message: string;
  organizationId?: string | null;
  actorId?: string | null;
  meta?: Record<string, unknown>;
}

export async function logEvent(
  input: LogEventInput,
): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return;
    await supabase.from("system_logs").insert({
      level: input.level ?? "info",
      event: input.event,
      message: input.message,
      organization_id: input.organizationId ?? null,
      actor_id: input.actorId ?? null,
      meta: input.meta ?? {},
    });
  } catch (e) {
    // 日志失败不阻断业务 —— 平台日志兜底
    console.error("[logEvent]", input.event, e instanceof Error ? e.message : e);
  }
}

/** 显式传入 client 的版本(worker/route 场景,避免重复建 client) */
export async function logEventWith(
  supabase: SupabaseClient,
  input: LogEventInput,
): Promise<void> {
  try {
    await supabase.from("system_logs").insert({
      level: input.level ?? "info",
      event: input.event,
      message: input.message,
      organization_id: input.organizationId ?? null,
      actor_id: input.actorId ?? null,
      meta: input.meta ?? {},
    });
  } catch (e) {
    console.error("[logEventWith]", input.event, e instanceof Error ? e.message : e);
  }
}
