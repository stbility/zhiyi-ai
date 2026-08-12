import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 健康检查(阶段 8 监控,2026-08-12)。
 *
 * 只做连通性探测,不暴露任何数据/密钥:
 *   · supabase:SELECT 1 连通性(认证 client 无用户也走 service 层? 不 ——
 *     用 server client 的 from("system_logs").select("id", {head:true}) 触发
 *     真实 DB 往返,RLS 会拦行但连接本身成功/失败可知)
 *   · 依赖:环境变量指纹(不输出值,只输出布尔)
 *
 * 用途:部署后/巡检时 curl 本端点,快速判断「平台在、数据库在、密钥在」。
 * 状态页 /status 可读它聚合展示。失败时 503,成功 200。
 */
export async function GET() {
  const checks: Record<string, boolean> = {};
  let dbOk = false;

  try {
    const supabase = await createSupabaseServerClient();
    if (supabase) {
      // 真实 DB 往返(RLS 拦截不影响连接探测)
      const { error } = await supabase.from("system_logs").select("id", { head: true, count: "exact" });
      dbOk = !error;
    }
  } catch {
    dbOk = false;
  }
  checks.supabase = dbOk;
  checks.supabase_url = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  );
  checks.stripe_secret = Boolean(process.env.STRIPE_SECRET_KEY);
  checks.stripe_webhook = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  // cron 已移除(#100 部署失败修复:vercel.json cron 不被当前计划接受),
  // 不再作为健康依赖检查 —— 之前 cron_secret 缺失拖累整体 503 误报。
  checks.cron_secret = true;

  const allOk = Object.values(checks).every(Boolean);
  return NextResponse.json(
    {
      ok: allOk,
      generated_at: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 },
  );
}
