import type { Metadata } from "next";
import Link from "next/link";

import { ProviderManager, type ProviderRow } from "@/components/app/ProviderManager";
import { isEncryptionAvailable } from "@/lib/crypto/secret-box";
import { getMyOrganizations } from "@/lib/db/queries";
import type { ProviderKind } from "@/lib/providers/registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "模型服务 · 智一 AI" };
export const dynamic = "force-dynamic";

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

  const providers = await loadProviders(org.id);
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
        canManage={canManage}
        encryptionAvailable={isEncryptionAvailable()}
      />
    </div>
  );
}
