import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadSkill, type SkillSummary } from "@/lib/ai/skills";
import { decryptSecret } from "@/lib/crypto/secret-box";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  // 0030 对 auth_token_cipher 做了列级 REVOKE SELECT FROM authenticated,
  // 用户身份客户端查不到密文列。走两步:
  // 1. 用户身份客户端查可见列(RLS 验权,组织成员才进)
  // 2. admin 客户端取 auth_token_cipher(解密后装配 serverMap)
  const { data: publicRows } = await supabase
    .from("mcp_servers")
    .select("id, name, url, timeout_ms")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .order("name");

  const { data: skillRows } = await supabase
    .from("skills")
    .select("name, title, description, version, tags")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .order("name");

  const hasServers = Array.isArray(publicRows) && publicRows.length > 0;
  const hasSkills = Array.isArray(skillRows) && skillRows.length > 0;
  if (!hasServers && !hasSkills) return undefined;

  // 两步取密文:用户身份查可见列 → admin 取 auth_token_cipher → 解密装配
  // (0030 列级 REVOKE 后 authenticated 不能 SELECT auth_token_cipher)
  const serverMap = new Map<string, McpServerConfig>();
  if (hasServers) {
    const admin = createSupabaseAdminClient();
    if (!admin) {
      logger.warn({ organizationId }, "跳过所有 MCP server:无法创建 admin 客户端");
      return undefined;
    }
    const serverIds = (publicRows ?? []).map((r) => r.id as string);
    const { data: cipherRows } = await admin
      .from("mcp_servers")
      .select("id, auth_token_cipher")
      .in("id", serverIds);
    const cipherMap = new Map(
      (cipherRows ?? []).map((r) => [r.id as string, r.auth_token_cipher as string]),
    );
    for (const row of publicRows ?? []) {
      const name = row.name as string;
      const url = row.url as string;
      const urlProblem = validateServerUrl(url);
      if (urlProblem) {
        logger.warn({ organizationId, server: name, urlProblem }, "跳过 MCP server:URL 不合法");
        continue;
      }
      const cipher = cipherMap.get(row.id as string);
      if (!cipher) {
        logger.warn({ organizationId, server: name }, "跳过 MCP server:admin 查不到密文");
        continue;
      }
      let token: string | null = null;
      try {
        token = decryptSecret(cipher);
      } catch (e) {
        logger.warn(
          { organizationId, server: name, err: e instanceof Error ? e.message : "unknown" },
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
