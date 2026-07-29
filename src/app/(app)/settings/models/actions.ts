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

/**
 * 单个模型探测的等待上限。
 *
 * 候选是并发探测的,所以这也约等于整个测试流程的耗时上限。取 25 秒是为了
 * 给排队中的模型一点机会,同时离 Vercel 的函数时限(300 秒)留足余量。
 */
const PROBE_TIMEOUT_MS = 25_000;

/**
 * 同时探测多少个模型。
 *
 * 取小值是为了不触发服务商限流 —— 一次打出几十个请求,能用的模型也会
 * 被限流判成不可用,等于用测试手段制造假故障。
 */
const PROBE_CONCURRENCY = 4;

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
  /** 服务商真实返回的全部模型标识 */
  let allModels: string[] = [];
  /** 属于核心家族、准备逐个真实探测的候选 */
  let candidates: readonly string[] = [];

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

        // 服务商返回的是「账号能访问的全部模型」,动辄上百个,里面还混着
        // 向量嵌入、安全分类、文档解析等根本没有对话端点的东西。
        // 只取核心家族的对话模型作为候选,其余一律不导入。
        //
        // 这里绝不截断列表 —— 之前写了 .slice(0, 100),把排在后面的
        // z-ai/glm-* 整个家族砍掉了,用户根本看不到智谱的模型。
        const { selectCoreChatModels } = await import(
          "@/lib/providers/model-filter"
        );
        allModels = [...fromOpenAi, ...fromGoogle];
        candidates = selectCoreChatModels(allModels);
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

  // 逐个真实调用候选模型,只有确实回了内容的才入库。
  //
  // /models 只说明「这个账号能看到该模型」,不说明它能对话。所以不真调一次
  // 就入库,等于把没验证过的东西摆给用户选 —— 那就是伪模型。宁可列表短,
  // 也不能有一个点开是坏的。
  /** 真调通过,确认可用 */
  const verified: string[] = [];
  /** 此刻排队/限流,但模型本身没问题 —— 保留可选,只记一句现状 */
  const busy: { model: string; reason: string }[] = [];
  /** 确实用不了(下线、无对话端点),从列表剔除 */
  const rejected: { model: string; reason: string }[] = [];

  if (ok && candidates.length > 0) {
    const { probeChatModel } = await import("@/lib/ai/gateway");
    const credentials = {
      kind: provider.kind as ProviderKind,
      baseUrl: (provider.base_url as string | null) ?? null,
      apiKeyCipher: provider.api_key_cipher as string,
    };

    // 分批并发。
    //
    // 串行太慢(十来个模型能跑掉几分钟,撞函数时限),但全量并发同样不行 ——
    // 一次打出几十个请求会触发服务商限流,好模型也会被判成不可用,
    // 那就是用测试手段制造假故障。限制并发数是两头都要顾。
    //
    // 也绝不截断候选列表:上一版写死 .slice(0, 100) 把智谱整个家族砍没了。
    const results: Awaited<ReturnType<typeof probeChatModel>>[] = [];
    for (let i = 0; i < candidates.length; i += PROBE_CONCURRENCY) {
      const batch = candidates.slice(i, i + PROBE_CONCURRENCY);
      results.push(
        ...(await Promise.all(
          batch.map((model) =>
            probeChatModel({ credentials, model, timeoutMs: PROBE_TIMEOUT_MS }),
          ),
        )),
      );
    }

    // 三分,而不是二分。
    //
    // 真实教训:deepseek-v4-flash 报「排队已满」、deepseek-v4-pro 探测超时,
    // 这两个都是容量问题,模型本身好好的。当时按「失败即剔除」处理,
    // 结果用户从此在列表里再也看不到 DeepSeek —— 因为一次堵车就把路拆了。
    for (const r of results) {
      if (r.ok) verified.push(r.model);
      else if (r.transient)
        busy.push({ model: r.model, reason: r.reason ?? "暂时不可用" });
      else rejected.push({ model: r.model, reason: r.reason ?? "调用失败" });
    }

    // 通过的、以及只是排队的,都留在可选列表里(chat_unavailable_reason 为空)。
    // 排队的模型此刻调用可能失败,但对话与工作流都有自动降级,不会因此中断。
    const selectable = [...verified, ...busy.map((b) => b.model)];
    if (selectable.length > 0) {
      await supabase.from("ai_models").upsert(
        selectable.map((id) => ({
          provider_id: parsed.data.id,
          organization_id: provider.organization_id as string,
          model_id: id,
          display_name: id.length > 60 ? id.slice(0, 60) : id,
          chat_unavailable_reason: null,
        })),
        { onConflict: "provider_id,model_id" },
      );
    }

    // 确实用不了的也要落库并标记原因,而不是悄悄丢掉 —— 用户有权知道
    // 「为什么我在英伟达控制台看得到这个模型,这里却没有」。
    if (rejected.length > 0) {
      await supabase.from("ai_models").upsert(
        rejected.map((r) => ({
          provider_id: parsed.data.id,
          organization_id: provider.organization_id as string,
          model_id: r.model,
          display_name: r.model.length > 60 ? r.model.slice(0, 60) : r.model,
          chat_unavailable_reason: r.reason.slice(0, 300),
        })),
        { onConflict: "provider_id,model_id" },
      );
    }
  }

  revalidatePath("/settings/models");
  revalidatePath("/assistant");

  if (!ok) return { error: `连接失败:${failure ?? "未知原因"}` };

  const { coreModelFamilyLabels } = await import(
    "@/lib/providers/model-filter"
  );
  const families = coreModelFamilyLabels().join("、");

  if (candidates.length === 0) {
    return {
      ok: `连接成功,密钥可用。但该服务商返回的 ${allModels.length} 个模型里没有核心家族(${families})的对话模型。`,
    };
  }

  const parts = [
    `连接成功。从服务商的 ${allModels.length} 个模型中筛出 ${candidates.length} 个核心家族(${families})候选,逐个真实调用验证。`,
    verified.length > 0
      ? `✅ ${verified.length} 个确认可用:${verified.join("、")}`
      : "⚠️ 没有一个当场通过验证",
  ];
  if (busy.length > 0) {
    parts.push(
      `⏳ ${busy.length} 个此刻排队中,已保留在可选列表(调用时会自动降级到可用模型):${busy
        .map((b) => `${b.model} — ${b.reason}`)
        .join(";")}`,
    );
  }
  if (rejected.length > 0) {
    parts.push(
      `❌ ${rejected.length} 个确实不可用,已从列表移除:${rejected
        .map((r) => `${r.model} — ${r.reason}`)
        .join(";")}`,
    );
  }

  return { ok: parts.join("\n") };
}
