import { NextResponse } from "next/server";

import { getServerEnv } from "@/lib/env/server";
import { getServiceAvailability } from "@/lib/services/availability";

export const dynamic = "force-dynamic";

/**
 * 生产实况 JSON —— 机器可读的「到底上线了什么」。
 *
 * 用途(2026-08-10 开发治理):
 *   1. 部署后校验 workflow 轮询它,断言 deployed_sha == origin/main SHA
 *      ——「渲染阻断/部署滞后」从此是 check 红,不再靠人猜。
 *   2. 新窗口 bootstrap.sh 拉它,开工就知道生产实况,不读旧克隆。
 *   3. 应用层/页面可读它显示「当前生产 = 某 SHA,与仓库一致/滞后」。
 *
 * 只报告存在性(布尔),绝不输出任何密钥值。
 */
export async function GET() {
  const env = getServerEnv();
  const services = getServiceAvailability();

  // Price ID 环境变量名与 src/lib/billing/stripe.ts 的 getPriceIdForPlan 保持一致
  // (2026-08-10 清理后命名:PRO/PRO_PLUS/TEAM/ENT × _MONTH/_YEAR)。
  const priceKeys = [
    "STRIPE_PRICE_PRO_MONTH",
    "STRIPE_PRICE_PRO_YEAR",
    "STRIPE_PRICE_PRO_PLUS_MONTH",
    "STRIPE_PRICE_PRO_PLUS_YEAR",
    "STRIPE_PRICE_TEAM_MONTH",
    "STRIPE_PRICE_TEAM_YEAR",
    "STRIPE_PRICE_ENT_MONTH",
    "STRIPE_PRICE_ENT_YEAR",
  ] as const;

  const payload = {
    ok: true,
    deployed_sha:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
      process.env.RENDER_GIT_COMMIT ??
      null,
    commit_ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    generated_at: new Date().toISOString(),
    env_fingerprint: {
      supabase_url: Boolean(env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL),
      stripe_secret: Boolean(env.STRIPE_SECRET_KEY),
      stripe_webhook: Boolean(env.STRIPE_WEBHOOK_SECRET),
      stripe_prices_configured: priceKeys.filter(
        (k) => Boolean(env[k]),
      ).length,
      stripe_prices_total: priceKeys.length,
      embeddings: Boolean(
        process.env.EMBEDDINGS_API_URL && process.env.EMBEDDINGS_API_KEY,
      ),
      encryption_key: Boolean(env.ENCRYPTION_KEY),
    },
    services: services.map((s) => ({
      key: s.key,
      status: s.status,
      label: s.label,
    })),
  };

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
