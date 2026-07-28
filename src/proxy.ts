import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 会话刷新代理(Next.js 16 起该文件由 middleware.ts 更名为 proxy.ts)。
 *
 * Supabase 的会话令牌有有效期,必须在每次请求时尝试刷新并把新 Cookie 写回响应。
 * Server Component 无法写 Cookie,所以这件事只能在 middleware 里做 —— 否则用户
 * 会在令牌过期后被静默登出。
 *
 * 同时承担路由保护:未登录访问受保护路由时重定向到登录页,
 * 已登录访问认证页时重定向到工作台。
 *
 * 注意:这里用 getUser() 而不是 getSession()。getSession() 读的是 Cookie 里的
 * 内容,可被伪造;getUser() 会向 Supabase 校验令牌真伪。鉴权必须用后者。
 */

/** 需要登录才能访问 */
const PROTECTED_PREFIXES = [
  "/today",
  "/workflow",
  "/knowledge",
  "/memory",
  "/assistant",
  "/reports",
  "/billing",
  "/settings",
];

/** 已登录用户不应再看到的页面 */
const AUTH_ONLY_PATHS = ["/login", "/register", "/forgot-password"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  // 认证未配置:不做任何跳转。受保护页面各自显示「未配置」,
  // 而不是把用户重定向到一个同样不可用的登录页。
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && PROTECTED_PREFIXES.some((p) => path.startsWith(p))) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    // 登录后回到原本要去的地方
    redirect.searchParams.set("next", path);
    return NextResponse.redirect(redirect);
  }

  if (user && AUTH_ONLY_PATHS.includes(path)) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/today";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * 排除静态资源与图片优化请求 —— 它们不需要会话,
     * 每次都跑一遍鉴权是纯粹的延迟浪费。
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
