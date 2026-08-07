import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadSkill, type SkillSummary } from "@/lib/ai/skills";
import { decryptSecret } from "@/lib/crypto/secret-box";
import type { McpClientToolContext } from "@/lib/ai/tools";
import type { McpServerConfig } from "@/lib/mcp/client";
import { validateServerUrl } from "@/lib/mcp/client";
import { logger } from "@/lib/log";

/**
 * 外部能力上下文装配 —— 把数据库里的 mcp_servers + skills 变成
 * agent 工具循环能用的 McpClientToolContext。
 *
 * 与 credentials.ts 同一条安全纪律:密文只能走 service_role 取,
 * 授权判断由调用方先用用户身份客户端完成(读得到行 = RLS 认可)。
 * 这里只负责:取启用的 server → 解密令牌 → 校验 url → 装配。
 *
 * 单点失败不拖垮整体:某个 server 令牌解密失败,只跳过它,
 * 其余 server 与技能库照常装配 —— 一个坏配置不该让整轮 agent 瘫痪。
 */

/** 按 org 装配外部能力上下文。任何一步失败都降级,不抛错 */
export async function buildExternalContext(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<McpClientToolContext | undefined> {
  // 先拿启用的 server(不含密文列)。查不到 = 没配 = 无外部能力,
  // 返回 undefined,agent 行为与旧版完全一致。
  const { data: servers } = await supabase
    .from("mcp_servers")
    .select("id, name, url, auth_token_cipher, timeout_ms")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .order("name");

  const { data: skillRows } = await supabase
    .from("skills")
    .select("name, title, description, version, tags")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .order("name");

  const hasServers = Array.isArray(servers) && servers.length > 0;
  const hasSkills = Array.isArray(skillRows) && skillRows.length > 0;
  // 两者都没有:没有外部能力,不装配。agent 行为与旧版完全一致
  if (!hasServers && !hasSkills) return undefined;

  const serverMap = new Map<string, McpServerConfig>();
  for (const row of servers ?? []) {
    const name = row.name as string;
    const url = row.url as string;

    const urlProblem = validateServerUrl(url);
    if (urlProblem) {
      logger.warn(
        { organizationId, server: name, urlProblem },
        "跳过 MCP server:URL 不合法",
      );
      continue;
    }

    let token: string | null = null;
    try {
      token = decryptSecret(row.auth_token_cipher as string);
    } catch (e) {
      logger.warn(
        {
          organizationId,
          server: name,
          err: e instanceof Error ? e.message : "unknown",
        },
        "跳过 MCP server:令牌解密失败",
      );
      continue;
    }

    serverMap.set(name, {
      id: row.id as string,
      name,
      url,
      authToken: token,
      timeoutMs: (row.timeout_ms as number) ?? 15000,
    });
  }

  const skills: SkillSummary[] = (skillRows ?? []).map((r) => ({
    name: r.name as string,
    title: r.title as string,
    description: r.description as string,
    version: r.version as string,
    tags: (r.tags as string[] | null) ?? [],
  }));

  return {
    servers: serverMap,
    skills,
    loadSkill: (name) => loadSkill(organizationId, name),
  };
}
