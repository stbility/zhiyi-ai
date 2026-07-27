import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseCredentials } from "@/lib/env/server";

/**
 * 服务端 Supabase 客户端(用户身份)。
 *
 * 使用可公开密钥 + 用户会话 Cookie,因此所有查询都受 RLS 约束 ——
 * 这是默认且唯一推荐的服务端读写方式。
 *
 * 需要绕过 RLS 的运维操作请单独走 service role 客户端,并且必须显式说明理由。
 */
export async function createSupabaseServerClient() {
  const { url, publishableKey } = getSupabaseCredentials();
  if (!url || !publishableKey) return null;

  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component 中无法写 Cookie —— 会话刷新由 middleware 负责,
          // 这里静默忽略是 @supabase/ssr 的既定用法。
        }
      },
    },
  });
}

/** 当前登录用户;未登录或未配置时返回 null */
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}
