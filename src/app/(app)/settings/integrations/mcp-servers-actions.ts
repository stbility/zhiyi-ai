"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { encryptSecret, maskApiKey } from "@/lib/crypto/secret-box";
import { validateServerUrl, mcpInitialize } from "@/lib/mcp/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/log";

/**
 * 外部 MCP server 的登记与维护。
 *
 * 与 mcp-actions.ts 同一条纪律:写操作走**用户身份客户端**,
 * 「谁能改」由迁移 0030 的 RLS 策略(限 owner/admin)决定,
 * 不依赖这段代码写得对不对。
 *
 * 凭据处理:与 integrations 同模式 —— AES-256-GCM 加密落库,
 * 界面只显示掩码。明文只在这个文件里出现一次(表单提交时),
 * 之后库里只有密文。
 */

export interface McpServerState {
  readonly error?: string;
  readonly ok?: string;
}

const createSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
  name: z
    .string()
    .trim()
    .min(1, "请给这个 server 起个名字")
    .max(40, "名字过长")
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "名字只能含小写字母、数字、连字符、下划线"),
  url: z.string().trim().min(1, "请填写 server 地址").max(500, "地址过长"),
  authToken: z.string().trim().min(1, "请填写访问令牌").max(1000, "令牌过长"),
  timeoutMs: z.coerce
    .number()
    .int("超时必须是整数秒")
    .min(1, "超时至少 1 秒")
    .max(60, "超时最多 60 秒"),
});

export async function createMcpServer(
  _prev: McpServerState,
  formData: FormData,
): Promise<McpServerState> {
  const parsed = createSchema.safeParse({
    organizationId: formData.get("organizationId"),
    name: formData.get("name"),
    url: formData.get("url"),
    authToken: formData.get("authToken"),
    timeoutMs: formData.get("timeoutMs"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  // url 校验在应用层再做一道 —— https 强制,http 仅 localhost
  const urlProblem = validateServerUrl(parsed.data.url);
  if (urlProblem) return { error: urlProblem };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  // 加密落在服务端 —— 明文不落库、不下发
  let cipher: string;
  let masked: string;
  try {
    cipher = encryptSecret(parsed.data.authToken);
    masked = maskApiKey(parsed.data.authToken);
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : "unknown" },
      "加密 MCP server 令牌失败",
    );
    return {
      error: "无法加密令牌:加密密钥未配置。请先在服务端配置 ENCRYPTION_KEY。",
    };
  }

  const { error } = await supabase.from("mcp_servers").insert({
    organization_id: parsed.data.organizationId,
    name: parsed.data.name,
    url: parsed.data.url,
    auth_token_cipher: cipher,
    auth_token_masked: masked,
    timeout_ms: parsed.data.timeoutMs * 1000,
    created_by: user.id,
  });

  if (error) {
    if (error.code === "42501") {
      return {
        error: "没有权限登记 MCP server。只有组织的所有者或管理员可以操作。",
      };
    }
    // 23505 = 唯一约束冲突(同组织同名)
    if (error.code === "23505") {
      return { error: "同名 server 已存在。名字在同一组织内必须唯一。" };
    }
    logger.error({ dbError: error.message }, "登记 MCP server 失败");
    return { error: error.message };
  }

  revalidatePath("/settings/integrations");
  return { ok: `已登记 ${parsed.data.name}。智能体将在下一轮运行时自动使用它的工具。` };
}

const idSchema = z.object({
  id: z.string().uuid("标识无效"),
  organizationId: z.string().uuid("组织标识无效"),
});

/** 测试连接:真的去调一次 initialize。结果落库,界面显示。 */
export async function testMcpServer(
  _prev: McpServerState,
  formData: FormData,
): Promise<McpServerState> {
  const parsed = idSchema.safeParse({
    id: formData.get("id"),
    organizationId: formData.get("organizationId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  // 密文只走 service_role 取 —— 但授权判断在此之前已完成:
  // 用用户身份客户端先读这一行,读得到就说明 RLS 认可访问权
  const { data: row } = await supabase
    .from("mcp_servers")
    .select("name, url, auth_token_cipher, timeout_ms")
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId)
    .maybeSingle();
  if (!row) return { error: "找不到这个 server,或你没有权限访问它。" };

  let token: string;
  try {
    token = await decryptCipher(row.auth_token_cipher as string);
  } catch {
    return { error: "令牌解密失败。请删除后重新登记。" };
  }

  const outcome = await mcpInitialize({
    id: parsed.data.id,
    name: row.name as string,
    url: row.url as string,
    authToken: token,
    timeoutMs: (row.timeout_ms as number) ?? 15000,
  });

  const { error } = await supabase
    .from("mcp_servers")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: outcome.ok,
      last_test_error: outcome.ok ? null : outcome.message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId);

  if (error) {
    logger.error({ dbError: error.message }, "写入测试结果失败");
    return { error: "测试执行了,但结果写库失败:" + error.message };
  }

  revalidatePath("/settings/integrations");
  return outcome.ok
    ? { ok: "连接成功。" }
    : { error: `连接失败:${outcome.message}` };
}

/** 启停。关掉的 server 不再向 agent 暴露工具,但配置保留。 */
export async function toggleMcpServer(
  _prev: McpServerState,
  formData: FormData,
): Promise<McpServerState> {
  const parsed = idSchema.safeParse({
    id: formData.get("id"),
    organizationId: formData.get("organizationId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  // 先读当前状态(用户身份 → RLS 决定能否读到)
  const { data: row } = await supabase
    .from("mcp_servers")
    .select("enabled")
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId)
    .maybeSingle();
  if (!row) return { error: "找不到这个 server,或你没有权限访问它。" };

  const { error, count } = await supabase
    .from("mcp_servers")
    .update(
      { enabled: !row.enabled, updated_at: new Date().toISOString() },
      { count: "exact" },
    )
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId);

  if (error) {
    if (error.code === "42501") {
      return { error: "没有权限修改。只有组织的所有者或管理员可以操作。" };
    }
    return { error: error.message };
  }
  if ((count ?? 0) === 0) return { error: "没有权限修改,或它已被删除。" };

  revalidatePath("/settings/integrations");
  return {
    ok: row.enabled
      ? "已停用。它的工具不再出现在智能体里,配置保留。"
      : "已启用。智能体将在下一轮运行时加载它的工具。",
  };
}

/** 删除。连配置带密文一起移除 —— 不留无用的凭据残骸。 */
export async function deleteMcpServer(
  _prev: McpServerState,
  formData: FormData,
): Promise<McpServerState> {
  const parsed = idSchema.safeParse({
    id: formData.get("id"),
    organizationId: formData.get("organizationId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("mcp_servers")
    .delete({ count: "exact" })
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId);

  if (error) {
    if (error.code === "42501") {
      return { error: "没有权限删除。只有组织的所有者或管理员可以操作。" };
    }
    return { error: error.message };
  }
  if ((count ?? 0) === 0) return { error: "没有权限删除,或它已被删除。" };

  revalidatePath("/settings/integrations");
  return { ok: "已删除。它的工具立即从智能体里消失。" };
}

/**
 * 解密服务端令牌密文。
 *
 * 与 credentials.ts 同模式:密文只能走 service_role 取(RLS 列级 revoke
 * 让 authenticated 读不到),而 service_role 绕过 RLS —— 所以授权判断
 * 必须在调用这里之前由用户身份客户端完成。testMcpServer 里先读行再解密,
 * 顺序不能颠倒。
 */
async function decryptCipher(cipher: string): Promise<string> {
  // 动态 import 避免在 server action 顶层引入副作用
  const { decryptSecret } = await import("@/lib/crypto/secret-box");
  return decryptSecret(cipher);
}
