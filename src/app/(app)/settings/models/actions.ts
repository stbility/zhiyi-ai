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
    baseUrl: formData.get("baseUrl") ?? "",
    apiKey: formData.get("apiKey"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const { organizationId, kind, baseUrl, apiKey } = parsed.data;
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

  // 名称由系统生成,不让用户填 —— 多一个必填字段就多一道卡住人的门槛,
  // 而这个名字对功能没有任何影响,只是列表里的一个标签。
  const displayName = await generateDisplayName(
    supabase,
    organizationId,
    baseUrl ?? spec.defaultBaseUrl ?? spec.label,
    spec.label,
  );

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
    if (error.code === "23505") return { error: "该服务已添加过,请勿重复添加。" };
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

/**
 * 生成便于辨认的名称。
 *
 * 优先用接口地址的域名(如 api.deepseek.com -> deepseek),
 * 取不到就退回服务商类型名。同组织内重名时追加序号。
 */
async function generateDisplayName(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  organizationId: string,
  source: string,
  fallback: string,
): Promise<string> {
  let base = fallback;
  try {
    const host = new URL(source).hostname;
    const parts = host.split(".").filter((p) => p !== "www" && p !== "api");
    if (parts.length > 0) base = parts[0] as string;
  } catch {
    // source 不是合法 URL,直接用服务商类型名
  }

  if (!supabase) return base;

  const { data } = await supabase
    .from("ai_providers")
    .select("display_name")
    .eq("organization_id", organizationId);

  const taken = new Set((data ?? []).map((r) => r.display_name as string));
  if (!taken.has(base)) return base;

  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
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
    .select("id, kind, base_url, api_key_cipher, organization_id")
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
  let discoveredModels: string[] = [];

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

    if (ok) {
      // 各家返回结构不同,取到哪种算哪种;取不到不影响测试结果
      try {
        const payload = (await response.json()) as {
          data?: { id?: string }[];
          models?: { name?: string; id?: string }[];
        };
        const fromOpenAi = (payload.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string");
        const fromGoogle = (payload.models ?? [])
          .map((m) => m.name ?? m.id)
          .filter((id): id is string => typeof id === "string")
          // Google 返回 models/gemini-x 形式,去掉前缀便于调用
          .map((id) => id.replace(/^models\//, ""));
        discoveredModels = [...fromOpenAi, ...fromGoogle].slice(0, 100);
      } catch {
        // 响应不是预期结构,不影响「连接成功」这一事实
      }
    }

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

  // 连接正常时顺带把可用模型导进来 —— 否则用户得自己去文档里抄模型名,
  // 抄错了又只能在对话时才发现。
  let importedCount = 0;
  if (ok && discoveredModels.length > 0) {
    const rows = discoveredModels.map((id) => ({
      provider_id: parsed.data.id,
      organization_id: provider.organization_id as string,
      model_id: id,
      display_name: id.length > 60 ? id.slice(0, 60) : id,
    }));

    const { error: upsertError } = await supabase
      .from("ai_models")
      .upsert(rows, { onConflict: "provider_id,model_id", ignoreDuplicates: true });

    if (!upsertError) importedCount = rows.length;
  }

  revalidatePath("/settings/models");
  revalidatePath("/assistant");

  if (!ok) return { error: `连接失败:${failure ?? "未知原因"}` };
  return {
    ok:
      importedCount > 0
        ? `连接成功,已导入 ${importedCount} 个可用模型。`
        : "连接成功,密钥可用。",
  };
}
