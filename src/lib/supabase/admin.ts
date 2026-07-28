import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseCredentials } from "@/lib/env/server";

/**
 * 服务端管理客户端(service role)。
 *
 * 这把密钥绕过全部 RLS,能力等同数据库管理员。使用纪律:
 *   1. 只在服务端使用。本模块带 server-only 标记,客户端误引用会在构建期报错。
 *   2. 只用于「用户身份客户端做不到、且确有正当理由」的操作,并在调用点写明理由。
 *   3. 绝不用它来图省事绕过 RLS 做普通业务查询 —— 那会让整套行级安全形同虚设。
 *
 * 未配置时返回 null,由调用方如实降级,不抛错。
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const { url, secretKey } = getSupabaseCredentials();
  if (!url || !secretKey) return null;

  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** service role 是否可用 —— 用于判断能否走管理员兜底路径 */
export function hasAdminAccess(): boolean {
  return getSupabaseCredentials().secretKey !== undefined;
}

