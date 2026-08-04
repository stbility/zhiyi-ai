import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/supabase/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getGitHubAppConfig,
  getInstallation,
  getInstallationToken,
} from "@/lib/integrations/github";
import { logger } from "@/lib/log";

/**
 * GitHub App 安装回调。
 *
 * 用户在 GitHub 上点完「Install」之后被送回这里,带着 installation_id。
 * 我们要做的是:确认这个安装真的存在(拿它换一次令牌),然后记到组织名下。
 *
 * 安全上有两处不能省:
 *
 * 1. **必须校验 state。** 回调是公开地址,任何人都能构造一个带
 *    installation_id 的请求打过来。没有 state 的话,攻击者可以把
 *    **他自己的**安装绑到**你的**组织上 —— 之后他的仓库出现在你的工作区里
 *    还算轻的,反过来他也能借你的组织读到你连的仓库。
 *    state 里带上组织 id 并签名,回来时验签。
 *
 * 2. **必须确认调用者已登录且是该组织的管理员。** 这一步靠 RLS 兜底
 *    (写策略限定 owner/admin),但这里也要先判一次,好给出像样的提示 ——
 *    让人一路点到最后才发现没权限是很糟的体验。
 */

export const dynamic = "force-dynamic";

/** 用 App 私钥给 state 签名。不引入额外密钥 —— 私钥本来就在服务端 */
async function verifyState(
  state: string,
): Promise<{ ok: true; organizationId: string } | { ok: false; reason: string }> {
  const config = getGitHubAppConfig();
  if (!config) return { ok: false, reason: "尚未配置 GitHub App。" };

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return { ok: false, reason: "state 格式不正确。" };

  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", config.privateKey)
    .update(payload)
    .digest("base64url");

  // 定长比较,避免通过响应时间逐字节猜出签名
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "state 校验失败,请重新从「集成」页发起连接。" };
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      organizationId?: string;
      issuedAt?: number;
    };
    if (!decoded.organizationId) {
      return { ok: false, reason: "state 缺少组织标识。" };
    }
    // 过期的 state 不认 —— 否则一个旧链接可以被无限次重放
    if (!decoded.issuedAt || Date.now() - decoded.issuedAt > 15 * 60_000) {
      return { ok: false, reason: "连接链接已过期,请重新发起。" };
    }
    return { ok: true, organizationId: decoded.organizationId };
  } catch {
    return { ok: false, reason: "state 无法解析。" };
  }
}

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/settings/integrations";
  url.search = "";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const installationId = request.nextUrl.searchParams.get("installation_id");
  const state = request.nextUrl.searchParams.get("state");

  if (!installationId) {
    // 「没有返回安装标识」本身是事实,但对用户是个死胡同 —— 他配好了
    // 回调地址,GitHub 也确实跳回来了,却被告知缺了个他没听说过的东西。
    //
    // GitHub App 有**两个**不同的回调字段,而 installation_id 只在其中
    // 一条路径上出现(docs.github.com/apps 的原文):
    //
    //   Setup URL     用户**安装**完 App 后跳这里,带 installation_id
    //   Callback URL  用户**授权**(OAuth web flow)后跳这里,带 code
    //
    //   「If you select Request user authorization (OAuth) during
    //     installation, you will not be able to enter a setup URL.
    //     Users will instead be redirected to the Callback URL」
    //
    // 所以只把地址填进 Callback URL、又没勾那个选项时,安装完根本不会
    // 带 installation_id 回来。这不是用户填错了,是两个字段的分工。
    //
    // 把 GitHub 实际送来了哪些参数一并说出来 —— 有 code 没 installation_id
    // 是「走了授权流程」,两个都没有是「地址被直接访问」,
    // 对用户是两件完全不同的事。
    const 收到的参数 = [...request.nextUrl.searchParams.keys()];
    const 走了授权流程 = 收到的参数.includes("code");
    return back(request, {
      githubError:
        `GitHub 这次回调没有带 installation_id` +
        (收到的参数.length > 0 ? `(实际带回的是:${收到的参数.join("、")})` : "(没有带任何参数)") +
        `。` +
        (走了授权流程
          ? `带回的是 code,说明走的是「用户授权」流程而不是「安装」流程。`
          : ``) +
        `installation_id 只在安装流程里出现 —— 它对应 GitHub App 设置页里的 ` +
        `Setup URL;而 Callback URL 对应的是授权流程。` +
        `两条路都走这个地址的话,需要在 GitHub App 设置页勾选 ` +
        `「Request user authorization (OAuth) during installation」` +
        `(勾上之后 Setup URL 会变成不可填,安装也会跳 Callback URL),` +
        `或者把这个地址同时填进 Setup URL。`,
    });
  }
  if (!state) {
    return back(request, {
      githubError: "缺少 state,已拒绝。请从「集成」页重新发起连接。",
    });
  }

  const checked = await verifyState(state);
  if (!checked.ok) return back(request, { githubError: checked.reason });

  const user = await getCurrentUser();
  if (!user) return back(request, { githubError: "请先登录后再连接。" });

  // 确认这个安装真的存在且我们能用它 —— 拿它换一次令牌是最直接的验证。
  // 不做这一步的话,一个不存在的 installation_id 也会被写进库,
  // 界面上显示「已连接」,直到用户真去拉代码才发现是空的。
  const auth = await getInstallationToken(installationId);
  if (!auth.ok) return back(request, { githubError: auth.error });

  const supabase = await createSupabaseServerClient();
  if (!supabase) return back(request, { githubError: "认证服务未配置。" });

  // 账号名与授权范围只能问 GitHub 要。
  // 上一版把 URL 里的 setup_action 当成了 repository_selection ——
  // 那个值是 "install" / "update",表示这次动作是安装还是更新,
  // 和「授权了哪些仓库」完全无关。字段名与内容对不上的数据比不存更糟。
  const info = await getInstallation(installationId);

  const { error } = await supabase.from("git_installations").upsert(
    {
      organization_id: checked.organizationId,
      provider: "github",
      installation_id: installationId,
      account_login: info.accountLogin,
      repository_selection: info.repositorySelection,
      connected_by: user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,provider" },
  );

  if (error) {
    logger.error(
      { organizationId: checked.organizationId, dbError: error.message },
      "写入 GitHub 安装记录失败",
    );
    // RLS 会挡下非管理员 —— 这时要说清楚是权限问题,而不是笼统的「失败」
    return back(request, {
      githubError: `未能保存连接(可能是没有管理员权限):${error.message}`,
    });
  }

  return back(request, { githubOk: "1" });
}
