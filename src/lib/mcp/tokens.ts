import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/log";

/**
 * MCP 访问令牌的签发与验证。
 *
 * 这是本系统第一个**面向公网、不走浏览器会话**的入口。浏览器那条路上,
 * 身份由 Supabase 会话 Cookie + RLS 一起兜底,应用层判断错了数据库还能挡住。
 * 这条路上没有那层兜底 —— 令牌解析出的 organization_id 就是最终结论,
 * 之后所有查询都以它为准。所以这个文件里的每一处都要按「唯一防线」写。
 *
 * 三条纪律:
 *   1. 令牌明文只在签发的那一刻存在,之后只存 sha256。数据库被拖走也用不了。
 *   2. 比较用定长比较 —— 逐字节早退会把哈希值一位一位地泄露出去。
 *   3. 验证走 service_role:哈希列对 authenticated 不可读(见迁移 0022),
 *      而且这一步本来就没有用户会话可用。
 */

/** 令牌前缀。让人一眼看出这是什么,泄露到日志里时也能立刻认出来 */
const TOKEN_PREFIX = "zhiyi_mcp_";

/** 界面上显示多少位。剩余熵仍有 ~200 位,不构成泄露 */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 6;

export interface IssuedToken {
  /** 完整令牌。**只有这一次能拿到**,之后库里只有哈希 */
  readonly token: string;
  /** 存库用的哈希 */
  readonly tokenHash: string;
  /** 界面展示用的前缀 */
  readonly tokenPrefix: string;
}

/** 生成一把新令牌。32 字节随机数,足够高熵 */
export function issueToken(): IssuedToken {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * 令牌哈希。
 *
 * 用 SHA-256 而不是 bcrypt/argon2:那类慢哈希是为低熵口令防暴力破解设计的,
 * 而这里是 32 字节随机数 —— 穷举它跟穷举密钥本身一样不可行,
 * 慢哈希只会让每次 API 调用多花几十毫秒。
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 定长比较两个哈希 —— 逐字节早退会泄露哈希内容 */
export function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 从 Authorization 头里取出令牌。取不到返回 null,不猜 */
export function readBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface TokenIdentity {
  readonly tokenId: string;
  readonly organizationId: string;
  readonly name: string;
}

/**
 * 验证令牌,返回它代表的组织。
 *
 * 返回 null 表示这次请求没有身份 —— 调用方必须当作未授权处理,
 * **不允许有任何「拿不准就放行」的分支**。这条路上没有 RLS 兜底。
 */
export async function verifyToken(
  token: string | null,
): Promise<TokenIdentity | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const admin = createSupabaseAdminClient();
  if (!admin) {
    // 没有 service_role 就无法验证。这时**必须拒绝**,不能放行 ——
    // 配置缺失不是放宽安全的理由。
    logger.error({}, "未配置 service role,MCP 令牌无法验证,一律拒绝");
    return null;
  }

  const hash = hashToken(token);
  const { data, error } = await admin
    .from("mcp_access_tokens")
    .select("id, organization_id, name, token_hash, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error) {
    logger.error({ dbError: error.message }, "查询 MCP 令牌失败");
    return null;
  }
  if (!data) return null;
  if (data.revoked_at !== null) return null;

  // 上面已经按哈希做了等值查询,这里再定长比较一次。
  // 等值查询走的是数据库索引,比较逻辑不在我们控制之内;
  // 多这一次是为了让「比较方式」这件事在代码里是显式的、可审的。
  if (!hashEquals(data.token_hash as string, hash)) return null;

  // 记一次使用时间。失败不影响验证结果 —— 这是审计信息,不是安全判断
  void admin
    .from("mcp_access_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id as string)
    .then(({ error: e }) => {
      if (e) logger.warn({ dbError: e.message }, "更新 MCP 令牌使用时间失败");
    });

  return {
    tokenId: data.id as string,
    organizationId: data.organization_id as string,
    name: data.name as string,
  };
}
