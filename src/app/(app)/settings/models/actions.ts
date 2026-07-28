"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { encryptSecret, isEncryptionAvailable, maskApiKey } from "@/lib/crypto/secret-box";
import { getProviderSpec, type ProviderKind } from "@/lib/providers/registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 模型服务的增删与连接测试。
 *
 * 密钥全程只在服务端出现:表单提交到这里 → 立刻加密 → 落库存密文。
 * 数据库里没有明文,界面回显只用掩码。
 */

const addSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
  kind: z.enum(["openai", "anthropic", "google", "openai_compatible"]),
  displayName: z
    .string()
    .trim()
    .min(1, "请填写名称")
    .max(60, "名称不能超过 60 个字符"),
  baseUrl: z
    .string()
    .trim()
    .url("Base URL 格式不正确")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  apiKey: z.string().trim().min(1, "请填写 API 密钥"),
});

export interface ProviderActionState {
  readonly error?: string;
  readonly hint?: string;
  readonly ok?: string;
}

export async function addProvider(
  _prev: ProviderActionState,
  formData: FormData,
): Promise<ProviderActionState> {
  if (!isEncryptionAvailable()) {
    return {
      error: "密钥加密不可用,拒绝保存。",
      hint: "ENCRYPTION_KEY 未配置或格式不正确。绝不以明文存储密钥。",
    };
  }

  const parsed = addSchema.safeParse({
    organizationId: formData.get("organizationId"),
    kind: formData.get("kind"),
    displayName: formData.get("displayName"),
    baseUrl: formData.get("baseUrl") ?? "",
    apiKey: formData.get("apiKey"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const { organizationId, kind, displayName, baseUrl, apiKey } = parsed.data;
  const spec = getProviderSpec(kind as ProviderKind);

  if (spec.requiresBaseUrl && !baseUrl) {
    return { error: "该接入方式必须填写 Base URL。" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const { error } = await supabase.from("ai_providers").insert({
    organization_id: organizationId,
    kind,
    display_name: displayName,
    base_url: baseUrl ?? spec.defaultBaseUrl ?? null,
    api_key_cipher: encryptSecret(apiKey),
    api_key_masked: maskApiKey(apiKey),
    created_by: user.id,
  });

  if (error) {
    if (error.code === "23505") return { error: "该名称已被占用,请换一个。" };
    if (error.code === "42501") {
      return {
        error: "没有权限添加模型服务。",
        hint: "只有组织的所有者或管理员可以配置模型服务。",
      };
    }
    return { error: error.message };
  }

  revalidatePath("/settings/models");
  return { ok: "已添加。建议立即测试连接,确认密钥可用。" };
}

const idSchema = z.object({ id: z.string().uuid() });

export async function deleteProvider(
  _prev: ProviderActionState,
  formData: FormData,
): Promise<ProviderActionState> {
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error } = await supabase
    .from("ai_providers")
    .delete()
    .eq("id", parsed.data.id);

  if (error) return { error: error.message };

  revalidatePath("/settings/models");
  return { ok: "已删除。" };
}

/**
 * 连接测试 —— 用真实密钥调用对方接口。
 *
 * 结果如实写回数据库,成功就是成功、失败就记下失败原因。
 * 绝不因为「填了密钥」就认为可用 —— 那正是需求禁止的伪装已接通。
 */
export async function testProvider(
  _prev: ProviderActionState,
  formData: FormData,
): Promise<ProviderActionState> {
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { data: provider, error: loadError } = await supabase
    .from("ai_providers")
    .select("id, kind, base_url, api_key_cipher")
    .eq("id", parsed.data.id)
    .single();

  if (loadError || !provider) return { error: "未找到该模型服务。" };

  const spec = getProviderSpec(provider.kind as ProviderKind);
  const baseUrl =
    (provider.base_url as string | null) ?? spec.defaultBaseUrl ?? "";

  if (!baseUrl) {
    return { error: "缺少 Base URL,无法测试。" };
  }

  let ok = false;
  let failure: string | null = null;

  try {
    const { decryptSecret } = await import("@/lib/crypto/secret-box");
    const apiKey = decryptSecret(provider.api_key_cipher as string);

    // 各家鉴权头不同,按 Provider 类型分派
    const headers: Record<string, string> =
      provider.kind === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : provider.kind === "google"
          ? {}
          : { Authorization: `Bearer ${apiKey}` };

    const url =
      provider.kind === "google"
        ? `${baseUrl}${spec.testPath}?key=${encodeURIComponent(apiKey)}`
        : `${baseUrl}${spec.testPath}`;

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    ok = response.ok;
    if (!ok) {
      // 只记录状态码与简短原因,绝不把响应体原样落库 —— 里面可能回显密钥
      failure = `接口返回 HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        failure = "密钥被拒绝(HTTP " + response.status + "),请检查密钥是否正确";
      }
    }
  } catch (e) {
    failure =
      e instanceof Error && e.name === "TimeoutError"
        ? "连接超时(15 秒)"
        : "无法连接到该地址";
  }

  await supabase
    .from("ai_providers")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: ok,
      last_test_error: failure,
    })
    .eq("id", parsed.data.id);

  revalidatePath("/settings/models");
  return ok
    ? { ok: "连接成功,密钥可用。" }
    : { error: `连接失败:${failure ?? "未知原因"}` };
}
