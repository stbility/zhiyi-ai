"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * 浏览器端 Supabase 客户端。
 *
 * 只使用可公开的 publishable / anon 密钥 —— 它受行级安全策略(RLS)约束,
 * 即便泄露也无法越权读写。service role 密钥绝不允许出现在这一侧。
 *
 * 未配置时返回 null,而不是抛错或连到假地址:调用方据此显示「未配置」,
 * 这是产品硬性要求。
 */
export function createSupabaseBrowserClient() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  if (!url || !key) return null;

  return createBrowserClient(url, key);
}
