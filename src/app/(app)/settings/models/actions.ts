"use server";

import { revalidatePath } from "next/cache";

import { loadProviderCipher } from "@/lib/ai/credentials";
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
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 同时探测多少个模型。
 *
 * 取小值是为了不触发服务商限流 —— 一次打出几十个请求,能用的模型也会
 * 被限流判成不可用,等于用测试手段制造假故障。
 */
const PROBE_CONCURRENCY = 8;

/**
 * 探测的总时间预算。
 *
 * 探测只是「提前告知」,不该拖垮整个测试连接。英伟达有上百个模型,
 * 全部探完必然撞上 Vercel 的 300 秒函数上限 —— 那会让整个动作被强杀,
 * 结果一个模型都没导入。超出预算就停下,并如实说明还有多少没探。
 */
const PROBE_BUDGET_MS = 120_000;

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
  // 命名逻辑抽到 lib/providers/display-name.ts,那里有对应测试。
  // 早先这里是「取主机名第一段」,对 api.deepseek.com 恰好正确,
  // 对 integrate.api.nvidia.com 就取成了子域名 —— 模型选择器显示成
  // 「integrate · z-ai/glm-5.2」,用户完全看不出这是英伟达。
  const { displayNameForBaseUrl } = await import(
    "@/lib/providers/display-name"
  );
  const base = displayNameForBaseUrl(source) ?? fallback;

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

  const { error, count } = await supabase
    .from("ai_providers")
    .delete({ count: "exact" })
    .eq("id", parsed.data.id);

  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

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
    // 密文不在这里取:迁移 0018 之后它对 authenticated 不可读。
    // 这一行能读到就说明 RLS 认可访问权,之后才用 service_role 取密文。
    .select("id, kind, base_url, organization_id")
    .eq("id", parsed.data.id)
    .single();

  if (loadError || !provider) return { error: "未找到该模型服务。" };

  const spec = getProviderSpec(provider.kind as ProviderKind);
  const baseUrl =
    (provider.base_url as string | null) ?? spec.defaultBaseUrl ?? "";

  if (!baseUrl) {
    return { error: "缺少 Base URL,无法测试。" };
  }

  // 用户此前删除过的模型,导入时跳过 —— 删了又被导回来是最烦人的那类 bug
  const { data: exclusionRows } = await supabase
    .from("ai_model_exclusions")
    .select("model_id")
    .eq("provider_id", parsed.data.id);
  const excluded = new Set(
    (exclusionRows ?? []).map((r) => r.model_id as string),
  );

  // 探测与真实调用都要用到密文,统一在这里取一次(已通过上面的 RLS 判权)
  const providerCipher = (await loadProviderCipher(parsed.data.id)) ?? "";

  let ok = false;
  let failure: string | null = null;
  /** 服务商真实返回的全部模型标识 */
  let allModels: string[] = [];
  /** 属于核心家族、准备逐个真实探测的候选 */
  let candidates: readonly string[] = [];

  try {
    const { decryptSecret } = await import("@/lib/crypto/secret-box");
    const cipher = await loadProviderCipher(parsed.data.id);
    if (!cipher) throw new Error("无法读取密钥密文");
    const apiKey = decryptSecret(cipher);

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
        // 按**用途**过滤,不按厂商。
        //
        // 之前用的是厂商前缀白名单(deepseek-ai/、moonshotai/、z-ai/…),
        // 那个维度从一开始就错了 —— 它只在英伟达这种带命名空间的标识上
        // 看起来正常。DeepSeek 官方 API 返回的是裸标识 deepseek-chat、
        // deepseek-reasoner,前缀一个都对不上,结果「连接正常、模型 0 个可用」。
        // OpenAI 的 gpt-4o、Moonshot 的 moonshot-v1-8k、智谱的 glm-4 同理。
        //
        // 该收窄的是「用途不是对话」(嵌入、重排、安全分类…),
        // 不是「厂商我没听过」。
        // **服务商返回什么就导入什么,一个都不丢。**
        //
        // 这里曾经用 filterChatModels 把「用途不是对话」的模型直接扔掉,
        // 用户根本看不到它们的存在,也没有办法把它们要回来。
        // 用户的原话:「你不要在底层代码里限制模型」「全部」。
        //
        // 而且这道过滤错过:moonshotai/kimi-k2.6 用户实测可用,
        // 我们的判断却把它排除掉了。我的模式匹配没有资格替他决定
        // 哪个模型该存在。
        //
        // 改成:全部导入,只用 enabled 这个**用户自己能翻的开关**来决定
        // 默认是否出现在助手页的下拉里。看得见、可翻转、不隐藏。
        allModels = [...fromOpenAi, ...fromGoogle];
        candidates = allModels.filter((id) => !excluded.has(id));
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

  // 注意:这里**先不写**测试结果。
  //
  // 因为到这一步为止,ok 只代表「GET /models 能列出模型」——
  // 而真正决定这个服务商有没有用的是「POST /chat/completions 能不能对话」,
  // 这是两件事。真实案例:英伟达的密钥能列出全部模型,发起对话却一律
  // 403 Authorization failed(账号缺少调用推理端点的权限)。
  // 界面上却挂着绿色的「连接正常」,用户完全不知道对话根本跑不通 ——
  // 这就是拿「能连上」冒充「能用」。
  //
  // 所以下面先做一次真实的对话探测,再据此写 last_test_ok。

  // 先入库,再探测。顺序很重要。
  //
  // 之前是「全部探完才写库」。DeepSeek 只有 2 个模型所以看起来正常,
  // 英伟达有上百个:并发 4、每个超时 25 秒、临时失败还重试 ——
  // 整个 Server Action 撞上 Vercel 的 300 秒函数上限被强杀,
  // 一条都没写进去。界面上就是「连接正常,模型 0 个可用」。
  //
  // 现在:候选先全部入库(用户立刻就能用),探测只用于**报告状态**,
  // 而且带总时间预算,探不完就如实说明还剩多少没探。
  // 模型能不能用,最终由真实调用决定 —— 探测本来就只是提前告知,
  // 不该成为「能不能入库」的前置条件。
  const verified: string[] = [];
  const busy: { model: string; reason: string }[] = [];
  const rejected: { model: string; reason: string }[] = [];
  let notProbed = 0;

  // 已经有模型的服务商,测试连接**只验证不改动**。
  //
  // 用户整理过的列表(比如英伟达上百个模型里只留 4 个常用的)是他的决定,
  // 不该被一次「测试连接」冲掉。此前每点一次就全量重导,用户的整理白做。
  //
  // 只有列表为空时才自动导入 —— 那是「首次接入」,此时导入才是帮忙。
  // 想重新拉取完整列表,删掉该服务商重新添加即可,那是明确的意图表达。
  const { count: existingCount } = await supabase
    .from("ai_models")
    .select("model_id", { count: "exact", head: true })
    .eq("provider_id", parsed.data.id);
  const alreadyCurated = (existingCount ?? 0) > 0;

  /** 对话是否真的跑得通。null = 没探测过 */
  let chatOk: boolean | null = null;
  let chatFailure: string | null = null;

  // 已整理过列表的服务商也必须验证对话 —— 否则「连接正常」只证明了能列表。
  // 只抽一个模型,一次调用、极少 token,代价可以忽略。
  if (ok && alreadyCurated) {
    const { data: sample } = await supabase
      .from("ai_models")
      .select("model_id")
      .eq("provider_id", parsed.data.id)
      .eq("enabled", true)
      .limit(1)
      .maybeSingle();

    if (sample?.model_id) {
      const { probeChatModel } = await import("@/lib/ai/gateway");
      const r = await probeChatModel({
        credentials: {
          kind: provider.kind as ProviderKind,
          baseUrl: (provider.base_url as string | null) ?? null,
          apiKeyCipher: providerCipher,
        },
        model: sample.model_id as string,
        timeoutMs: PROBE_TIMEOUT_MS,
        attempts: 1,
      });
      if (r.ok) {
        chatOk = true;
      } else if (r.transient) {
        // 排队、限流不代表服务商坏了 —— 不能据此判定连接失败
        chatOk = null;
        chatFailure = r.reason ?? null;
      } else {
        chatOk = false;
        chatFailure = r.reason ?? "对话调用被拒绝";
      }
    }
  }

  // 现在才写结果:能列表但不能对话的,一律不算「连接正常」
  const overallOk = ok && chatOk !== false;
  await supabase
    .from("ai_providers")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: overallOk,
      last_test_error: overallOk ? null : (failure ?? chatFailure),
    })
    .eq("id", parsed.data.id);

  if (ok && chatOk === false) {
    return {
      error:
        `密钥能通过认证、也能列出模型列表,但**发起对话被拒绝**,` +
        `所以这个服务商目前无法使用:${chatFailure}`,
    };
  }

  if (ok && candidates.length > 0 && !alreadyCurated) {
    const { error: upsertError } = await supabase.from("ai_models").upsert(
      candidates.map((id) => ({
        provider_id: parsed.data.id,
        organization_id: provider.organization_id as string,
        model_id: id,
        display_name: id.length > 60 ? id.slice(0, 60) : id,
        chat_unavailable_reason: null,
        // **全部启用。我不做任何判断。**
        //
        // 上一版我让「用途不是对话」的默认不勾选,那仍然是我在替用户
        // 决定 —— 用户的原话:「不要任何限制」。
        // 我的模式匹配没有资格给任何模型下判决,它已经错过一次
        // (moonshotai/kimi-k2.6 用户实测可用,我判它不该存在)。
        // 开关在用户手上,他关哪个是他的事。
        enabled: true,
      })),
      { onConflict: "provider_id,model_id" },
    );
    if (upsertError) {
      return { error: `导入模型失败:${upsertError.message}` };
    }

    // 探测预算。留足余量给上面的写库和下面的收尾,绝不让平台来强杀。
    const deadline = Date.now() + PROBE_BUDGET_MS;
    const { probeChatModel } = await import("@/lib/ai/gateway");
    const credentials = {
      kind: provider.kind as ProviderKind,
      baseUrl: (provider.base_url as string | null) ?? null,
      apiKeyCipher: providerCipher,
    };

    // 分批并发:串行太慢,全量并发会触发限流把好模型判成坏的。
    let i = 0;
    for (; i < candidates.length; i += PROBE_CONCURRENCY) {
      if (Date.now() > deadline) break;
      const batch = candidates.slice(i, i + PROBE_CONCURRENCY);
      const results = await Promise.all(
        batch.map((model) =>
          probeChatModel({
            credentials,
            model,
            timeoutMs: PROBE_TIMEOUT_MS,
            attempts: 1,
          }),
        ),
      );
      for (const r of results) {
        if (r.ok) verified.push(r.model);
        else if (r.transient)
          busy.push({ model: r.model, reason: r.reason ?? "暂时不可用" });
        else rejected.push({ model: r.model, reason: r.reason ?? "调用失败" });
      }
    }
    notProbed = Math.max(0, candidates.length - i);

    // 这里刻意**不**因为探测失败就停用模型。
    //
    // 探测是一次合成的一句话调用,它的失败不是模型的固有属性。仓库里记着
    // 一次真实事故:用户实测 moonshotai/kimi-k2.6 可用,而我们的探测报 404,
    // 界面上却长期挂着一条与事实相反的「不可用」。据此自动停用,等于把
    // 能用的模型藏起来,而用户完全不知道发生了什么。
    //
    // 垃圾模型的问题由**导入前的用途过滤**解决(见 model-filter.ts),
    // 那是按用途判断、可解释、不依赖一次可能失败的网络调用;
    // 剩下的判断权交给用户,界面负责把「验证过 / 未验证 / 上次失败」
    // 三种状态如实标出来,而不是替他决定。
    // 探测通过的记下时间戳,界面据此显示「已验证可对话」
    if (verified.length > 0) {
      await supabase
        .from("ai_models")
        // 只写「验证通过」这一个事实,**不碰 last_error**。
        // 既有策略是「测试连接不写任何失败状态」—— 探测是一次合成调用,
        // 它的成败不是模型的固有属性(kimi-k2.6 探测报 404 而实际可用)。
        // 清除旧留痕同样属于「据探测结果改状态」,一并不做:
        // 真实对话成功时 api/chat 会清,那才是事实。
        .update({ last_verified_at: new Date().toISOString() })
        .eq("provider_id", parsed.data.id)
        .in("model_id", verified);
    }
  }

  revalidatePath("/settings/models");
  revalidatePath("/assistant");

  if (!ok) return { error: `连接失败:${failure ?? "未知原因"}` };

  if (candidates.length === 0) {
    return {
      ok: `连接成功,密钥可用。但该服务商返回的 ${allModels.length} 个模型里没有可用于对话的。`,
    };
  }

  if (alreadyCurated) {
    return {
      ok:
        (chatOk === true
          ? "连接成功,已抽样发起一次真实对话并成功返回。"
          : "连接成功,密钥可用;抽样对话此刻排队或超时,未能验证,可稍后重试。") +
        `服务商当前提供 ${allModels.length} 个模型,` +
        `其中 ${candidates.length} 个可用于对话。\n` +
        `你的模型列表已保留,未做改动 —— 测试连接只验证密钥,不会覆盖你整理好的选择。\n` +
        `如需重新拉取完整列表,删除该服务商后重新添加即可。`,
    };
  }

  const parts = [
    `连接成功。服务商返回 ${allModels.length} 个模型,已全部导入并启用。`,
  ];
  if (verified.length > 0) {
    parts.push(`✅ 抽样验证 ${verified.length} 个可正常对话`);
  }
  if (busy.length > 0) {
    parts.push(`⏳ ${busy.length} 个此刻排队或超时,仍可选用(调用时会自动降级)`);
  }
  if (rejected.length > 0) {
    parts.push(
      `⚠️ ${rejected.length} 个本次调用未通过,仍保留在列表中,可自行删除:${rejected
        .slice(0, 5)
        .map((r) => r.model)
        .join("、")}${rejected.length > 5 ? " 等" : ""}`,
    );
  }
  if (notProbed > 0) {
    parts.push(
      `另有 ${notProbed} 个未在本次验证时限内测到 —— 它们同样已导入可用,能不能用由第一次真实调用决定。`,
    );
  }

  return { ok: parts.join("\n") };
}

const modelSchema = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().trim().min(1, "请填写模型标识").max(200),
});

/** 删除一个模型 —— 用不上的留在列表里只会干扰选择 */
export async function deleteModel(
  _prev: ProviderActionState,
  formData: FormData,
): Promise<ProviderActionState> {
  const parsed = modelSchema.safeParse({
    providerId: formData.get("providerId"),
    modelId: formData.get("modelId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { data: provider } = await supabase
    .from("ai_providers")
    .select("organization_id")
    .eq("id", parsed.data.providerId)
    .maybeSingle();
  if (!provider) return { error: "未找到该模型服务。" };

  const { error, count } = await supabase
    .from("ai_models")
    .delete({ count: "exact" })
    .eq("provider_id", parsed.data.providerId)
    .eq("model_id", parsed.data.modelId);
  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  // 记住这个决定,否则下次「测试连接」又把它导回来 —— 用户删了它,
  // 就是不想再看到它,不该被自动导入推翻。
  await supabase.from("ai_model_exclusions").upsert(
    {
      provider_id: parsed.data.providerId,
      organization_id: provider.organization_id as string,
      model_id: parsed.data.modelId,
    },
    { onConflict: "provider_id,model_id" },
  );

  revalidatePath("/settings/models");
  revalidatePath("/assistant");
  return { ok: `已删除 ${parsed.data.modelId},重新测试连接也不会再导入它。` };
}

/** 恢复一个此前被删除的模型 —— 删除是决定,不是永久黑名单 */
export async function restoreModel(
  _prev: ProviderActionState,
  formData: FormData,
): Promise<ProviderActionState> {
  const parsed = modelSchema.safeParse({
    providerId: formData.get("providerId"),
    modelId: formData.get("modelId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { data: provider } = await supabase
    .from("ai_providers")
    .select("organization_id")
    .eq("id", parsed.data.providerId)
    .maybeSingle();
  if (!provider) return { error: "未找到该模型服务。" };

  const { error, count } = await supabase
    .from("ai_model_exclusions")
    .delete({ count: "exact" })
    .eq("provider_id", parsed.data.providerId)
    .eq("model_id", parsed.data.modelId);
  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  // 直接放回列表,而不是让用户再去点别的按钮。
  //
  // 此前只删排除记录,真正的导回要等一次「列表为空时的测试连接」——
  // 而列表几乎不可能为空,所以「恢复」实际上什么都没恢复。
  // 按钮写着恢复就该恢复,不该留个需要用户自己猜的后半步。
  const { error: insertError } = await supabase.from("ai_models").upsert(
    {
      provider_id: parsed.data.providerId,
      organization_id: provider.organization_id as string,
      model_id: parsed.data.modelId,
      display_name:
        parsed.data.modelId.length > 60
          ? parsed.data.modelId.slice(0, 60)
          : parsed.data.modelId,
      chat_unavailable_reason: null,
    },
    { onConflict: "provider_id,model_id" },
  );
  if (insertError) return { error: `恢复失败:${insertError.message}` };

  revalidatePath("/settings/models");
  revalidatePath("/assistant");
  return { ok: `已恢复 ${parsed.data.modelId},现在可以在助手页选用。` };
}
