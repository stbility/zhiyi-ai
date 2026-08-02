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
  // 统一到正式域名。
  //
  // 生产上这个部署挂了三个别名:zhiyi-ai.vercel.app、zhiyi-ai-vivian10.vercel.app、
  // zhiyi-ai-git-main-vivian10.vercel.app。而 Cookie 是按域名隔离的 ——
  // 在别名域发起登录,回调却固定跳到正式域,会话 Cookie 就写在了正式域;
  // 用户回到别名域一看,还是未登录。表现就是「第三方登录成功了却用不了」。
  //
  // 与其在每处小心翼翼地对齐域名,不如只留一个域名:一个域名,一份 Cookie。
  // 只在正式环境做,预览部署各有各的临时域名,不能被卷进来。
  const canonicalHost = process.env["VERCEL_PROJECT_PRODUCTION_URL"];
  if (
    process.env["VERCEL_ENV"] === "production" &&
    canonicalHost &&
    request.headers.get("host") !== canonicalHost
  ) {
    const target = new URL(request.nextUrl.toString());
    target.host = canonicalHost;
    target.protocol = "https:";
    return NextResponse.redirect(target, 308);
  }

  let response = NextResponse.next({ request });

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  // 认证未配置:不做任何跳转。受保护页面各自显示「未配置」,
  // 而不是把用户重定向到一个同样不可用的登录页。
  if (!url || !key) return response;

  const path = request.nextUrl.pathname;

  // 没有会话 Cookie 就不必向 Supabase 校验。
  //
  // getUser() 是一次真实的网络往返(这正是它比 getSession() 可信的原因),
  // 而数据库与鉴权服务都在新加坡。匿名访客打开首页时,这次往返的结果
  // 必然是 null —— 没有 Cookie 就不可能有会话,既没有令牌要刷新,
  // 也没有身份要校验。为一个已知答案跨洋跑一趟,纯属浪费。
  //
  // 安全性不受影响:这里是「无 Cookie ⇒ 视为未登录」,方向是收紧而非放宽。
  // 伪造 Cookie 仍然过不了下面的 getUser() 校验。
  const hasSessionCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));

  if (!hasSessionCookie) {
    if (PROTECTED_PREFIXES.some((p) => path.startsWith(p))) {
      const redirect = request.nextUrl.clone();
      redirect.pathname = "/login";
      redirect.searchParams.set("next", path);
      return NextResponse.redirect(redirect);
    }
    return response;
  }

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
    error,
  } = await supabase.auth.getUser();

  // 令牌失效时把会话 Cookie 清干净。
  //
  // 生产日志里的实况:GoTrue 返回
  //   400 /token — Invalid Refresh Token: Refresh Token Not Found
  // 浏览器存着一个服务端已不存在的 refresh token。不清掉的话,之后每一次请求
  // 都会带着它再撞一次 400 —— 人刚登录成功就被弹回登录页,反复循环,
  // 等于被挡在门外。
  //
  // 清掉之后行为很简单:当作未登录,重新登一次就好。
  if (error && !user) {
    for (const c of request.cookies.getAll()) {
      // supabase-ssr 的会话 Cookie 统一是 sb-<project-ref>-auth-token[.n]
      if (c.name.startsWith("sb-") && c.name.includes("-auth-token")) {
        response.cookies.delete(c.name);
      }
    }
  }

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
