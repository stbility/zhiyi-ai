import type { Metadata } from "next";
import Link from "next/link";

import {
  IntegrationManager,
  type IntegrationRow,
} from "@/components/app/IntegrationManager";
import { GitConnection } from "@/components/app/GitConnection";
import { McpTokens, type McpTokenRow } from "@/components/app/McpTokens";
import { McpServersCard, type McpServerRow } from "@/components/app/McpServersCard";
import { isEncryptionAvailable } from "@/lib/crypto/secret-box";
import {
  getAppSlug,
  getGitHubAppConfig,
  getInstallation,
  privateKeyFingerprint,
  installUrl,
  issueState,
} from "@/lib/integrations/github";
import { getSiteUrl } from "@/lib/env/server";
import { logger } from "@/lib/log";
import { getCurrentOrganization } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "集成 · 智一 AI" };
export const dynamic = "force-dynamic";
// 「测试连接」会真调一次外部接口,比普通页面动作耗时
export const maxDuration = 60;

/**
 * 这个组织签发过的 MCP 令牌。
 *
 * 只取前缀,不取哈希 —— 迁移 0022 已经把 token_hash 从 authenticated
 * 的列白名单里去掉了,这里就算写上也读不到。列出来是为了让成员看得见
 * 「谁在通过 MCP 访问工作区」;撤销过的也留着,那是审计痕迹。
 */
async function loadMcpTokens(organizationId: string): Promise<McpTokenRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("mcp_access_tokens")
    .select("id, name, token_prefix, created_at, last_used_at, revoked_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    tokenPrefix: row.token_prefix as string,
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
  }));
}

async function loadMcpServers(organizationId: string): Promise<McpServerRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("mcp_servers")
    .select(
      "id, name, url, auth_token_masked, enabled, timeout_ms, last_tested_at, last_test_ok, last_test_error",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    url: row.url as string,
    credentialMasked: row.auth_token_masked as string,
    enabled: (row.enabled as boolean | null) ?? true,
    timeoutMs: (row.timeout_ms as number) ?? 15_000,
    lastTestedAt: (row.last_tested_at as string | null) ?? null,
    lastTestOk: (row.last_test_ok as boolean | null) ?? null,
    lastTestError: (row.last_test_error as string | null) ?? null,
  }));
}

async function loadIntegrations(
  organizationId: string,
): Promise<IntegrationRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("integrations")
    .select(
      "id, kind, display_name, credential_masked, enabled, last_tested_at, last_test_ok, last_test_error",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    displayName: row.display_name as string,
    credentialMasked: row.credential_masked as string,
    enabled: (row.enabled as boolean | null) ?? true,
    lastTestedAt: (row.last_tested_at as string | null) ?? null,
    lastTestOk: (row.last_test_ok as boolean | null) ?? null,
    lastTestError: (row.last_test_error as string | null) ?? null,
  }));
}

/**
 * 已连接的 Git 安装。没有就是没有,不编造。
 *
 * 【「库里有一行」不等于「连接可用」】
 *
 * 生产上出现过一条 installation_id = "<151228033>" 的记录 ——
 * 带尖括号。GitHub 的安装编号是纯数字,这个值编码后是 %3C…%3E,
 * 调任何接口都必然 404。而 account_login / repository_selection 都是 null,
 * 说明它不是回调写进去的(回调写库前会调 getInstallation 取这两个值)。
 *
 * 卡片当时照样显示「已连接」——因为判断依据只是「查到了一行」。
 * 这就是**状态真假不一致**:界面说通了,实际一个文件都读不到,
 * 而用户没有任何办法看出区别。
 *
 * 所以现在多做一步:拿这个安装编号真的去问一次 GitHub。
 * 问不到就如实说「记录在,但验证不过」,而不是继续说「已连接」。
 */
async function loadGitInstallation(organizationId: string) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from("git_installations")
    .select("installation_id, account_login, created_at, credential_error")
    .eq("organization_id", organizationId)
    .eq("provider", "github")
    .maybeSingle();

  if (!data) return null;

  const installationId = data.installation_id as string;

  // 先做**不联网**就能判的那一层:格式对不对。
  // 分开报的理由和私钥那次一样 —— 「值本身是坏的」和「GitHub 不认」
  // 是两件事、两个修法,混成一句会把人支去查一个没错的地方。
  const 格式合法 = /^[0-9]+$/.test(installationId);

  // 再问 GitHub。取到 account_login 就说明这个安装真实存在且我们能用它。
  const live = 格式合法
    ? await getInstallation(installationId)
    : { accountLogin: null, repositorySelection: null };

  const verified = 格式合法 && live.accountLogin !== null;
  const storedError = (data.credential_error as string | null) ?? null;

  // 验证通过就把存量的报错清掉。
  //
  // 【这是用户报的 bug,而且是同一个病的另一面】
  // credential_error 是**上一次尝试留下的存量值**。安装编号修好之后,
  // 卡片仍然读那个旧值,于是继续显示「凭据待修复」——
  // 存下来的状态压过了当下问得到的事实。
  //
  // 和「库里有一行就说已连接」是完全对称的两个错误:
  // 一个把陈旧的成功当成现在成功,一个把陈旧的失败当成现在失败。
  // 两者的修法是同一条:**以当下问得到的事实为准**。
  //
  // 清库失败不影响这次显示 —— 下面 return 的是 verified 算出来的值,
  // 不是库里那个。落库只是让下次少查一遍。
  if (verified && storedError) {
    const { error } = await supabase
      .from("git_installations")
      .update({
        credential_error: null,
        account_login: live.accountLogin,
        repository_selection: live.repositorySelection,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("provider", "github");
    if (error) {
      logger.warn(
        { organizationId, dbError: error.message },
        "验证已通过,但清除存量的凭据报错失败",
      );
    }
  }

  return {
    verified,
    formatValid: 格式合法,
    // 以 GitHub 当下的回答为准,库里那份只是缓存
    liveAccountLogin: live.accountLogin,
    installationId,
    accountLogin: (data.account_login as string | null) ?? null,
    connectedAt: data.created_at as string,
    // 非空 = 应用装上了,但本站的凭据换不到令牌。
    // 这和「没装上」是两回事,卡片必须分开显示。
    //
    // verified 为真时一律置空:那个值是上一次尝试的存量,
    // 而我们刚刚问过 GitHub 并且问到了 —— 当下的事实压过存量。
    credentialError: verified ? null : storedError,
  };
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ githubOk?: string; githubError?: string }>;
}) {
  const org = await getCurrentOrganization();

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">集成</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。集成凭据归属于组织,而非个人账户。
        </p>
        <Link
          href="/today"
          className="text-brand hover:text-brand-hover font-zh text-caption mt-3 inline-block"
        >
          前往创建组织
        </Link>
      </div>
    );
  }

  const integrations = await loadIntegrations(org.id);
  const mcpServers = await loadMcpServers(org.id);
  const canManage = org.role === "owner" || org.role === "admin";

  // App 未配置时不生成任何可点的入口 —— 给一个点了必然失败的按钮,
  // 和放一个空按钮是同一类问题
  const appConfig = getGitHubAppConfig();
  const gitInstallation = await loadGitInstallation(org.id);

  // slug 向 GitHub 查,不用环境变量里手填的那个。
  //
  // 填错的后果是「连接 GitHub」跳到 GitHub 的 404 —— 用户看到的不是
  // 我们的报错,完全无从判断哪里配错了。实际发生过:GitHub App 叫
  // zhiyi-ai-repo,而用户照着旧的 OAuth App 名字填了 zhiyi-ai。
  //
  // 取不到就**不生成链接**,由卡片显示「暂时取不到」——
  // 给一个必然 404 的按钮,和放一个空按钮是同一类问题。
  const slugResult = appConfig
    ? await getAppSlug()
    : { slug: null, source: "none" as const, error: null };

  // 只用**查证过存在**的 slug 拼链接。
  //
  // 「查证」有两条路,可信度不同但都算数:
  //   GET /app          —— 权威,但需要 JWT 认证,凭据不对就 401
  //   公开页 HEAD 200   —— 免鉴权,只证明这个 slug 真实存在
  //
  // 之前只认第一条,于是凭据一配错就彻底没有按钮 —— 而安装这条路
  // 本来只需要 slug,根本不需要我们能认证。用户其实知道自己的 slug,
  // 是我拒绝相信他填的值,又不肯花一个请求去查证它。
  //
  // 官方文档确认安装地址只有一种形式:
  //   https://github.com/apps/<slug>/installations/new
  // 没有用 client id 的替代路径,所以 slug 是硬需求。
  // 来源:docs.github.com/apps/sharing-github-apps/sharing-your-github-app
  const installHref = slugResult.slug
    ? installUrl(slugResult.slug, issueState(org.id))
    : null;
  const params = await searchParams;
  const mcpTokens = await loadMcpTokens(org.id);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">集成</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          智能体调用外部能力的入口。凭据加密存储,仅在服务端解密,不会下发到浏览器。
        </p>
      </header>

      <GitConnection
        configured={appConfig !== null}
        installation={gitInstallation}
        installHref={installHref}
        canManage={canManage}
        // 只给能改配置的人看 —— 普通成员既看不懂也改不动,
        // 对他们只是一段吓人的英文。
        slugError={canManage ? slugResult.error : null}
        // 同样只给能改配置的人看。指纹是公开值,但对普通成员没有意义。
        keyFingerprint={
          canManage && appConfig ? privateKeyFingerprint(appConfig) : null
        }
        notice={{
          ...(params.githubOk ? { ok: true } : {}),
          ...(params.githubError ? { error: params.githubError } : {}),
        }}
      />

      <McpTokens
        organizationId={org.id}
        tokens={mcpTokens}
        canManage={canManage}
        endpoint={`${getSiteUrl()}/api/mcp`}
      />

      <McpServersCard
        organizationId={org.id}
        servers={mcpServers}
        canManage={canManage}
      />

      <IntegrationManager
        organizationId={org.id}
        integrations={integrations}
        canManage={canManage}
        encryptionAvailable={isEncryptionAvailable()}
      />
    </div>
  );
}
