import type { Metadata } from "next";
import Link from "next/link";

import {
  ProviderManager,
  type ModelRow,
  type ProviderRow,
} from "@/components/app/ProviderManager";
import { isEncryptionAvailable } from "@/lib/crypto/secret-box";
import { getMyOrganizations } from "@/lib/db/queries";
import type { ProviderKind } from "@/lib/providers/registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "模型服务 · 智一 AI" };
export const dynamic = "force-dynamic";
// 「测试连接」会并发真实调用每个候选模型来验证可用性,比普通页面动作耗时。
// Server Action 走的是本路由,所以时限声明在这里。
// Vercel Hobby 计划上限即 300 秒,调不高。
export const maxDuration = 300;

async function loadProviders(organizationId: string): Promise<ProviderRow[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("ai_providers")
    .select(
      "id, kind, display_name, base_url, api_key_masked, last_tested_at, last_test_ok, last_test_error",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    kind: row.kind as ProviderKind,
    displayName: row.display_name as string,
    baseUrl: (row.base_url as string | null) ?? null,
    apiKeyMasked: row.api_key_masked as string,
    lastTestedAt: (row.last_tested_at as string | null) ?? null,
    lastTestOk: (row.last_test_ok as boolean | null) ?? null,
    lastTestError: (row.last_test_error as string | null) ?? null,
  }));
}

/**
 * 每个服务商下的模型清单,含被剔除的和原因。
 *
 * 被剔除的模型必须能看见。此前它们只是从下拉框里消失,用户在服务商控制台
 * 明明看得到 Kimi,系统里却无声无息 —— 只能怀疑是系统丢了模型。
 * 列出来并写清原因,才谈得上排查。
 */
/** 用户删除过的模型,按服务商归组 —— 界面上要能看到并随时恢复 */
async function loadExclusions(
  organizationId: string,
): Promise<Record<string, string[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return {};

  const { data } = await supabase
    .from("ai_model_exclusions")
    .select("provider_id, model_id")
    .eq("organization_id", organizationId)
    .order("model_id");

  const byProvider: Record<string, string[]> = {};
  for (const row of data ?? []) {
    const pid = row.provider_id as string;
    (byProvider[pid] ??= []).push(row.model_id as string);
  }
  return byProvider;
}

async function loadModels(
  organizationId: string,
): Promise<Record<string, ModelRow[]>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return {};

  const { data } = await supabase
    .from("ai_models")
    .select("provider_id, model_id, chat_unavailable_reason, last_error, enabled, last_verified_at")
    .eq("organization_id", organizationId)
    .order("model_id");

  const byProvider: Record<string, ModelRow[]> = {};
  for (const row of data ?? []) {
    const pid = row.provider_id as string;
    (byProvider[pid] ??= []).push({
      modelId: row.model_id as string,
      unavailableReason:
        (row.chat_unavailable_reason as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      enabled: (row.enabled as boolean | null) ?? true,
      lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
    });
  }
  return byProvider;
}

export default async function ModelSettingsPage() {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">模型服务</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。模型服务的密钥归属于组织,而非个人账户。
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

  const [providers, modelsByProvider, exclusionsByProvider] = await Promise.all([
    loadProviders(org.id),
    loadModels(org.id),
    loadExclusions(org.id),
  ]);
  const canManage = org.role === "owner" || org.role === "admin";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">模型服务</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          添加您自己的 API 密钥即可使用。密钥加密存储,仅在服务端解密,不会下发到浏览器。
        </p>
      </header>

      <ProviderManager
        organizationId={org.id}
        providers={providers}
        modelsByProvider={modelsByProvider}
        exclusionsByProvider={exclusionsByProvider}
        canManage={canManage}
        encryptionAvailable={isEncryptionAvailable()}
      />
    </div>
  );
}
