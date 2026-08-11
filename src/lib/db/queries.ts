import "server-only";

import { cookies } from "next/headers";

import { ensurePersonalOrganization } from "@/lib/auth/personal-org";
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
  const rows = await queryMyMemberships();
  if (rows === null) return [];

  // 一个组织都没有 —— 补建一个再查一遍。
  //
  // 【为什么自愈放在这里,而不是布局或登录回调里】
  //
  // 这是**唯一漏不掉的收口**。需要组织的地方有 9 处,其中
  // api/integrations/github/callback 和 settings/integrations/git-actions
  // 都不经过 (app) 布局 —— 放布局里就会漏掉它们,而"某条路径忘了处理"
  // 正是这类 bug 一再出现的方式。
  //
  // 代价是一个读函数带了写副作用。这里认这个代价:漏掉一条路径的后果是
  // 用户在那条路径上依然是空的,而那正是要修的病。
  //
  // 只在**确认为空**时才动手,正常用户多花的是零成本的一次判断。
  if (rows.length === 0) {
    const 补建了 = await ensurePersonalOrganization();
    if (补建了) {
      const again = await queryMyMemberships();
      return again === null ? [] : toOrganizations(again);
    }
    return [];
  }

  return toOrganizations(rows);
}

const ORG_COOKIE = "zhiyi_current_org";

/**
 * 当前组织(2026-08-11 组织切换器)。
 *
 * 优先读 cookie 里用户上次选择的组织;未选择或已失效(不再属于该组织)
 * 时回退第一个。cookie 存 org id,不存角色/名字 —— 那些每次从库读。
 *
 * 这是「页面固定取第一个组织」的收口:所有页面改用本函数后,
 * 多组织用户即可切换上下文。
 */
export async function getCurrentOrganization(): Promise<Organization | null> {
  const organizations = await getMyOrganizations();
  if (organizations.length === 0) return null;

  const cookieStore = await cookies();
  const chosen = cookieStore.get(ORG_COOKIE)?.value;
  if (chosen) {
    const match = organizations.find((o) => o.id === chosen);
    if (match) return match;
  }

  return organizations[0] ?? null;
}

/** 记录用户选择的组织到 cookie(供 getCurrentOrganization 读取)。 */
export async function rememberOrganization(organizationId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** 原始成员关系行。null 表示查询本身失败(与「查到 0 条」是两回事) */
async function queryMyMemberships(): Promise<unknown[] | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("memberships")
    .select("role, organizations (id, name, slug)")
    .eq("status", "active");

  // 查询出错时返回 null,不返回空数组 —— 否则一次网络抖动会被当成
  // 「这个用户没有组织」,触发一次毫无必要的补建
  if (error || !data) return null;
  return data;
}

function toOrganizations(data: readonly unknown[]): readonly Organization[] {
  return (data as { role: string; organizations: unknown }[]).flatMap((row) => {
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
