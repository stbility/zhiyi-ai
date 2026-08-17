import { NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/log";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cron 只做秒级标记,不需要长时执行
export const maxDuration = 30;

/**
 * Agent Runner 扫描器(Vercel Cron 专用,阶段 E)。
 *
 * 【职责边界(冻结)】
 *   只做:
 *     - lease recovery:过期 lease → interrupted(有步骤)/ failed(无步骤)
 *     - zombie recovery:同上
 *   严禁:
 *     - Agent Loop / Model / Tool 执行(Cron 在 Vercel Function 生命周期内)
 *
 * 【实现】调用 0067 RPC recover_expired_agent_runs(security definer,
 *   函数体内原子 UPDATE + generation+1,与 Runner 内 recoverExpiredLeases 同语义)。
 *
 * 【鉴权】带 CRON_SECRET,与 workflow worker 的 Cron 兜底同模式。
 */

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: NextRequest) {
  // Cron 鉴权
  if (request.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    logger.error("runner scan: service role 未配置");
    return new Response("service misconfigured", { status: 500 });
  }

  // 调用 0067 RPC:过期租约恢复(只标记,不执行 Agent)
  const { data, error } = await admin.rpc("recover_expired_agent_runs");
  if (error) {
    logger.error({ error }, "runner scan: 恢复失败");
    return new Response("scan error", { status: 500 });
  }

  logger.info(
    { recovered: data },
    "runner scan: 租约过期恢复完成",
  );

  return NextResponse.json({
    ok: true,
    recovered: data,
    note: "Cron 只做扫描/恢复标记,不执行任何 Agent 任务",
  });
}
