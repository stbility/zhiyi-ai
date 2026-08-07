import "server-only";

import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env/server";

/**
 * Stripe 服务端封装。
 *
 * 只在这里创建 Stripe 实例 —— 全站不出现第二处 `new Stripe(...)`。
 * 密钥未配置时返回 null,由调用方如实降级(404/503 + 文案),不抛错:
 * 这与全站「未接通的第三方服务必须如实展示」的规则一致。
 *
 * 【安全】STRIPE_SECRET_KEY 只在服务端读取,本模块带 server-only 标记。
 */

let stripeInstance: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (stripeInstance !== undefined) return stripeInstance;

  const key = getServerEnv().STRIPE_SECRET_KEY;
  if (!key) {
    stripeInstance = null;
    return null;
  }

  stripeInstance = new Stripe(key, {
    apiVersion: "2026-06-24.dahlia",
    typescript: true,
  });
  return stripeInstance;
}

/** Stripe 是否已配置 —— 未配置时购买入口必须禁用并如实说明 */
export function isStripeConfigured(): boolean {
  return getStripe() !== null;
}

/**
 * 取用户的 Stripe 客户 ID;没有则创建(幂等)。
 *
 * 为什么按 user_id 查映射表而不是直接 `customers.retrieve(email)`:
 * Stripe 客户与本站用户是一对一,email 只是展示字段、可改,不能当主键。
 * 0033 的 stripe_customers 表就是这张映射 —— 这里只读它,
 * 创建客户后由 webhook 路径回写(或在此直接写,二选一,保持单一写路径)。
 */
export async function getOrCreateCustomer(
  stripe: Stripe,
  supabaseAdmin: SupabaseClient,
  userId: string,
  email: string | undefined,
): Promise<{ customerId: string; error?: undefined } | { customerId?: undefined; error: string }> {
  // 已有映射 → 直接用
  const existing = await supabaseAdmin
    .from("stripe_customers")
    .select("customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing.data?.customer_id) {
    return { customerId: existing.data.customer_id };
  }
  if (existing.error) {
    return { error: `读取客户映射失败:${String(existing.error)}` };
  }

  // 没有 → 在 Stripe 创建客户,再落映射
  const customer = await stripe.customers.create({
    ...(email ? { email } : {}),
    metadata: { userId },
  });
  const saved = await supabaseAdmin
    .from("stripe_customers")
    .upsert({ user_id: userId, customer_id: customer.id })
    .select("customer_id")
    .single();
  if (saved.error) {
    return { error: `保存客户映射失败:${String(saved.error)}` };
  }
  return { customerId: customer.id };
}

/**
 * 校验 priceId 是否属于本产品允许的套餐。
 *
 * 只认 0034 定义的三个 plan_id,以及 Stripe Price 的 metadata.plan_id。
 * 在 Stripe 建 Price 时给每个 Price 加 metadata: { plan_id: "professional" }。
 * 校验失败 = 配置错误,返回 false,由调用方如实报「价格配置错误」,
 * 绝不把未知 Price 当成功。
 */
export const ALLOWED_PLAN_IDS = ["free", "professional", "enterprise"] as const;

export function planIdFromPrice(price: Stripe.Price | null | undefined): string | null {
  const planId = price?.metadata?.plan_id;
  if (!planId) return null;
  return ALLOWED_PLAN_IDS.includes(planId as (typeof ALLOWED_PLAN_IDS)[number])
    ? planId
    : null;
}
