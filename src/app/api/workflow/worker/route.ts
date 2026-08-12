import { NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMyOrganizations } from "@/lib/db/queries";
import { parseDefinition } from "@/lib/workflow/state-machine";
import { executeWorkflowSteps } from "@/lib/workflow/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 工作流 Worker(2026-08-12,阶段 4 收口)。
 *
 * 触发方式:
 *   1. 用户触发 —— 前端排队后轮询到 QUEUED,带用户 cookie 调本路由,
 *      校验 run 属于当前用户,以用户身份执行(步骤调 /api/agent 透传 cookie)。
 *   2. Vercel Cron 兜底 —— 带 CRON_SECRET,清理超过 10 分钟无人认领的
 *      僵尸 QUEUED(置 FAILED 并如实标注),不执行步骤(cron 无用户身份)。
 *
 * 诚实边界:步骤执行受 Vercel 函数 300s 平台时限约束(与 /api/agent 相同),
 * 超长工作流由人工闸门断点续跑,不是单窗口跑完。
 */

const ZOMBIE_AFTER_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const runId = searchParams.get("runId");
  const isCron = request.headers.get("Authorization") === `Bearer ${process.env.CRON_SECRET ?? ""}`;

  // Cron 兜底:清僵尸
  if (isCron) {
    const supabase = await createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ ok: false, error: "auth unconfigured" }, { status: 503 });
    const cutoff = new Date(Date.now() - ZOMBIE_AFTER_MS).toISOString();
    const { data: stale } = await supabase
      .from("workflow_runs")
      .select("id, workflow_id, created_at")
      .eq("status", "QUEUED")
      .lt("created_at", cutoff)
      .limit(20);
    let cleared = 0;
    for (const run of stale ?? []) {
      const { error: e1 } = await supabase
        .from("workflow_runs")
        .update({ status: "FAILED", finished_at: new Date().toISOString(), error: "执行超时(无人认领),请重试。" })
        .eq("id", run.id);
      if (e1) continue;
      await supabase
        .from("workflows")
        .update({ status: "READY", updated_at: new Date().toISOString() })
        .eq("id", run.workflow_id as string);
      cleared += 1;
    }
    return NextResponse.json({ ok: true, cleared });
  }

  // 用户触发:校验登录 + run 归属
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "认证服务未配置。" }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  const organizations = await getMyOrganizations();
  const organization = organizations?.[0];
  if (!organization) return NextResponse.json({ error: "没有可用的组织。" }, { status: 400 });

  // 找 run:指定 id 或当前用户第一个 QUEUED
  let query = supabase
    .from("workflow_runs")
    .select("id, workflow_id, status, created_at")
    .eq("status", "QUEUED");
  if (runId) query = query.eq("id", runId);
  const { data: run } = await query.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!run) {
    return NextResponse.json({ ok: true, nothing: true });
  }

  // run 必须属于当前用户的组织(workflows.organization_id 关联校验)
  const { data: workflow } = await supabase
    .from("workflows")
    .select("organization_id, definition, status")
    .eq("id", run.workflow_id as string)
    .maybeSingle();
  if (!workflow || workflow.organization_id !== organization.id) {
    return NextResponse.json({ error: "无权执行该运行。" }, { status: 403 });
  }

  let definition;
  try {
    definition = parseDefinition(workflow.definition);
  } catch (e) {
    await supabase.from("workflow_runs").update({ status: "FAILED", error: e instanceof Error ? e.message : "步骤定义无效。" }).eq("id", run.id);
    await supabase.from("workflows").update({ status: "FAILED", updated_at: new Date().toISOString() }).eq("id", run.workflow_id as string);
    return NextResponse.json({ error: "步骤定义无效。" }, { status: 400 });
  }

  // 置 RUNNING 开始执行
  await supabase.from("workflow_runs").update({ status: "RUNNING", started_at: new Date().toISOString() }).eq("id", run.id);
  await supabase.from("workflows").update({ status: "RUNNING", updated_at: new Date().toISOString() }).eq("id", run.workflow_id as string);

  const cookieHeader = request.headers.get("cookie") ?? "";
  const result = await executeWorkflowSteps(
    {
      supabase: supabase as never,
      organizationId: organization.id,
      userId: user.id,
    },
    run.workflow_id as string,
    run.id as string,
    definition,
    0,
    cookieHeader,
  );

  if (result.error) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  if (result.paused) {
    return NextResponse.json({ ok: true, paused: true, step: result.pausedStepTitle });
  }
  return NextResponse.json({ ok: true, message: result.ok ?? "完成。" });
}
