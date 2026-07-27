import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 退出登录。
 *
 * 用 POST 而非 GET:GET 会被浏览器预取、被 <img> 触发,导致用户莫名其妙被登出。
 * 退出是状态变更操作,必须走 POST。
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  if (supabase) await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), {
    status: 303,
  });
}
