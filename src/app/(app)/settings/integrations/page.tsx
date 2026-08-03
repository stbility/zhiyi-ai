import type { Metadata } from "next";
import Link from "next/link";

import {
  IntegrationManager,
  type IntegrationRow,
} from "@/components/app/IntegrationManager";
import { GitConnection } from "@/components/app/GitConnection";
import { isEncryptionAvailable } from "@/lib/crypto/secret-box";
import {
  getAppSlug,
  getGitHubAppConfig,
  installUrl,
  issueState,
} from "@/lib/integrations/github";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "集成 · 智一 AI" };
export const dynamic = "force-dynamic";
// 「测试连接」会真调一次外部接口,比普通页面动作耗时
export const maxDuration = 60;

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

/** 已连接的 Git 安装。没有就是没有,不编造 */
async function loadGitInstallation(organizationId: string) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from("git_installations")
    .select("installation_id, account_login, created_at")
    .eq("organization_id", organizationId)
    .eq("provider", "github")
    .maybeSingle();

  if (!data) return null;
  return {
    installationId: data.installation_id as string,
    accountLogin: (data.account_login as string | null) ?? null,
    connectedAt: data.created_at as string,
  };
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ githubOk?: string; githubError?: string }>;
}) {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

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
  const slug = appConfig ? await getAppSlug() : null;
  const installHref = slug ? installUrl(slug, issueState(org.id)) : null;
  const params = await searchParams;

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
        notice={{
          ...(params.githubOk ? { ok: true } : {}),
          ...(params.githubError ? { error: params.githubError } : {}),
        }}
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
