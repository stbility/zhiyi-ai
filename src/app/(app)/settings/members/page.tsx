import type { Metadata } from "next";

import { MembersManager, type MemberRow } from "@/components/settings/MembersManager";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "成员管理 · 智一 AI" };
export const dynamic = "force-dynamic";

/**
 * 成员管理(阶段 2 缺口,2026-08-11)。
 *
 * 组织成员列表 + 邀请/改角色/移除。数据库层(0001:memberships +
 * RLS 策略)早已完整,这里补齐前端。
 *
 * 权限:owner/admin 可管理成员(RLS memberships_insert_admin /
 * update_admin / delete_admin 已保证);普通成员只读列表。
 */

interface MemberWithProfile extends MemberRow {
  isSelf: boolean;
}

async function loadMembers(
  organizationId: string,
  currentUserId: string,
): Promise<MemberWithProfile[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("memberships")
    .select(
      "id, user_id, role, status, profiles (id, email, display_name)",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    role: row.role as string,
    status: row.status as string,
    email:
      ((row.profiles as { email?: string } | null)?.email as string | undefined) ??
      "",
    displayName:
      ((row.profiles as { display_name?: string | null } | null)
        ?.display_name as string | null | undefined) ?? null,
    isSelf: (row.user_id as string) === currentUserId,
  }));
}

export default async function MembersPage() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">成员管理</h2>
        <p className="text-fg-secondary font-zh text-caption">
          认证服务未配置,无法加载成员。
        </p>
      </main>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">成员管理</h2>
        <p className="text-fg-secondary font-zh text-caption">请先登录。</p>
      </main>
    );
  }

  const organizations = await getMyOrganizations();
  const org = organizations[0];
  if (!org) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">成员管理</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。成员归属于组织。
        </p>
      </main>
    );
  }

  const members = await loadMembers(org.id, user.id);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <MembersManager
        organizationId={org.id}
        currentUserId={user.id}
        members={members}
      />
    </main>
  );
}
