import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 应用数据读取。
 *
 * 全部走受 RLS 约束的用户身份客户端 —— 不使用 service role。
 * 这意味着即便这里的查询写错了范围,数据库层仍会兜住越权,
 * 安全不依赖应用层记得加 where 条件。
 */

export interface Profile {
  readonly id: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

export async function getProfile(): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (!data) return null;

  return {
    id: data.id as string,
    displayName: (data.display_name as string | null) ?? null,
    avatarUrl: (data.avatar_url as string | null) ?? null,
  };
}

/** 当前用户所属的组织。新用户为空数组 —— 这是合法状态,不是错误。 */
export async function getMyOrganizations(): Promise<readonly Organization[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("memberships")
    .select("role, organizations (id, name, slug)")
    .eq("status", "active");

  if (error || !data) return [];

  return data.flatMap((row) => {
    const org = row.organizations as unknown as {
      id: string;
      name: string;
      slug: string;
    } | null;
    if (!org) return [];
    return [
      {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: row.role as string,
      },
    ];
  });
}

export interface AuditEntry {
  readonly id: number;
  readonly action: string;
  readonly resourceType: string;
  readonly createdAt: string;
}

export async function getRecentAudit(
  organizationId: string,
  limit = 10,
): Promise<readonly AuditEntry[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, resource_type, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id as number,
    action: row.action as string,
    resourceType: row.resource_type as string,
    createdAt: row.created_at as string,
  }));
}
