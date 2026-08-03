"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logger } from "@/lib/log";
import { issueToken } from "@/lib/mcp/tokens";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * MCP 访问令牌的签发与撤销。
 *
 * 签发走**用户身份客户端**,不用 service role —— 于是「谁能开令牌」
 * 由迁移 0022 的 RLS 策略(限 owner/admin)决定,不依赖这段代码写得对不对。
 * 这条纪律和项目里其它写操作一致:能让数据库兜底的,就不要只靠应用层。
 *
 * 令牌明文只在这一次返回里出现。库里存的是 sha256,谁也还原不回来 ——
 * 包括我们自己。所以界面必须明说「这是唯一一次能看到它」。
 */

export interface McpTokenState {
  readonly error?: string;
  readonly ok?: string;
  /** 刚签发的令牌明文。**只有这一次**,之后永远拿不到 */
  readonly token?: string;
}

const createSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
  name: z
    .string()
    .trim()
    .min(1, "请给这把令牌起个名字")
    .max(60, "名字过长"),
});

export async function createMcpToken(
  _prev: McpTokenState,
  formData: FormData,
): Promise<McpTokenState> {
  const parsed = createSchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const issued = issueToken();

  const { error } = await supabase.from("mcp_access_tokens").insert({
    organization_id: parsed.data.organizationId,
    name: parsed.data.name,
    token_hash: issued.tokenHash,
    token_prefix: issued.tokenPrefix,
    created_by: user.id,
  });

  if (error) {
    // 42501 = RLS 拒绝。说清楚是权限问题,而不是笼统的「失败」
    if (error.code === "42501") {
      return { error: "没有权限签发 MCP 令牌。只有组织的所有者或管理员可以开令牌。" };
    }
    logger.error({ dbError: error.message }, "签发 MCP 令牌失败");
    return { error: error.message };
  }

  revalidatePath("/settings/integrations");
  return {
    token: issued.token,
    ok: "已签发。这是唯一一次能看到完整令牌 —— 现在就复制保存,关掉这个提示后无法再取回。",
  };
}

const revokeSchema = z.object({ id: z.string().uuid() });

/**
 * 撤销一把令牌。
 *
 * 不删行:删掉就查不出「这把曾经存在过、被谁用过」。撤销后 verifyToken
 * 会因为 revoked_at 非空直接拒绝,效果与删除一致,但留下了审计痕迹。
 */
export async function revokeMcpToken(
  _prev: McpTokenState,
  formData: FormData,
): Promise<McpTokenState> {
  const parsed = revokeSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("mcp_access_tokens")
    .update({ revoked_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", parsed.data.id)
    .is("revoked_at", null);

  if (error) return { error: error.message };
  // 0 行 = RLS 挡下了,或者它已经被撤销过。PostgREST 在 0 行时不报错,
  // 只判 error 会得到一句与事实相反的「已撤销」
  if ((count ?? 0) === 0) {
    return { error: "没有权限撤销,或这把令牌已经是撤销状态。" };
  }

  revalidatePath("/settings/integrations");
  return { ok: "已撤销。使用这把令牌的客户端会立刻失去访问权。" };
}
