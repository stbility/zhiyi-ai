import type { Metadata } from "next";

import { MembersManager, type MemberRow } from "@/components/settings/MembersManager";
import { getCurrentOrganization } from "@/lib/db/queries";
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

  const { data: rows } = await supabase
    .from("memberships")
    .select("id, user_id, role, status")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  // profiles 表真实 schema 不含 email(id/display_name/avatar_url/locale)。
  // email 只存在于 auth.users,用户身份客户端(RLS)读不到 —— 成员列表
  // 只展示 profiles 真实字段,不做嵌入查询(避免请求不存在的列)。
  const userIds = (rows ?? []).map((r) => r.user_id as string);
  const { data: profileRows } =
    userIds.length > 0
      ? await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", userIds)
      : { data: [] };
  const profileById = new Map(
    (profileRows ?? []).map((p) => [p.id as string, p]),
  );

  return (rows ?? []).map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    role: row.role as string,
    status: row.status as string,
    displayName:
      (profileById.get(row.user_id as string)?.display_name as
        | string
        | null
        | undefined) ?? null,
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

  const org = await getCurrentOrganization();
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
