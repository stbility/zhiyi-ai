import { NextResponse, type NextRequest } from "next/server";

import { safeRedirectPath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 邮箱验证与 OAuth 回调。
 *
 * Supabase 会把一次性 code 附在回调地址上,这里用它换取会话并写入 Cookie。
 *
 * next 参数来自 URL,属于不可信输入,一律经 safeRedirectPath 净化 ——
 * 否则构成开放重定向。该函数的边界情况由 tests/auth/redirect.test.ts 守护。
 */

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"));

  const errorDescription = searchParams.get("error_description");
  if (errorDescription) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", errorDescription);
    return NextResponse.redirect(url);
  }

  if (!code) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", "回调地址缺少验证参数,请重新发起登录。");
    return NextResponse.redirect(url);
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", "认证服务未配置。");
    return NextResponse.redirect(url);
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", error.message);
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(next, origin));
}
