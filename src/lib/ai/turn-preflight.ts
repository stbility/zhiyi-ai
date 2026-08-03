import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import type { ChatMessage } from "@/lib/ai/gateway";
import { logDbFailure } from "@/lib/log";
import {
  loadIntegrationCipher,
  loadProviderCipher,
} from "@/lib/ai/credentials";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 一轮请求在**分岔之前**必须完成的全部检查与准备。
 *
 * 为什么单独成一个模块:智一 AI 有两条通道 ——
 *
 *   /api/chat   AI 助手:单次流式生成,不碰工作区
 *   /api/agent  智能体:多步工具循环,产物写进工作区
 *
 * 这是 Claude 的分法:claude.ai 是思考伙伴,Claude Code 是工程师,
 * 两个真正不同的产品、两套不同的能力面 —— claude.ai 那些界面
 * **默认不会改你的仓库、不跑你的 shell、不提交代码**。
 *
 * 此前两条线挤在一个端点里,靠请求体里一个 `agent: true` 分岔,
 * 前端则靠 localStorage 里一个开关决定发不发这个字段。后果是反复出现的:
 * 改智能体那一侧,顺手动到共用代码,AI 助手跟着坏;反过来也一样。
 * 用户的原话是「两条线是分开的」—— 那就在代码里也分开。
 *
 * 但分开的是**执行形态**,不是入口检查。鉴权、限流、服务商归属、对话归属、
 * 附件落库、上下文装配、用户消息留痕 —— 这些两条线一字不差地都要做。
 * 复制一份的话,两份必然慢慢走样,而走样的那一侧就是下一个安全缺口。
 * 所以抽到这里,两条通道共用同一个实现。
 *
 * 这个模块是**纯搬运**:从原 /api/chat 路由里整段移出来,逻辑一个字没改,
 * 注释也照原样保留 —— 那些注释记的是每一处检查是被什么真实故障逼出来的。
 */

export const turnBodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  providerId: z.string().uuid("请选择模型服务"),
  model: z.string().trim().min(1, "请选择模型"),
  content: z.string().trim().min(1, "请输入内容").max(32_000, "内容过长"),
  /**
   * 本轮是否联网检索。
   *
   * 由用户显式开启,而不是让模型自己决定 —— 模型判断「要不要搜」并不可靠,
   * 而每次搜索都消耗配额。显式开关让成本和行为都可预期。
   */
  webSearch: z.boolean().optional(),
  /**
   * 本轮附带的项目文件。
   *
   * 单独成一个字段而不是拼进 content:用户自己打的字要保持可读、可回看,
   * 附件是另一回事。上限在服务端再校验一次 —— 浏览器侧的限制随时可以绕过。
   */
  attachments: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(400),
        content: z.string().max(400_000),
      }),
    )
    .optional()
    // 不限文件个数,只约束总量 —— 真实项目动辄上千个文件,
    // 卡个数只会把源码截断。总量上限来自请求体大小这个物理约束。
    .refine(
      (list) =>
        (list ?? []).reduce((n, a) => n + a.content.length, 0) <= 1_200_000,
      { message: "附件总量超过上限,请选择更小的目录" },
    ),
});

export function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * 落库一条助手消息,失败时留痕。
 *
 * 这几处写入发生在模型调用**之后** —— 钱已经花了,撤不回来,所以不能
 * 像前面那样直接失败。但也绝不能静默:RLS 拒绝时什么都没存下,
 * 用户下次进来发现回答不见了,而日志里一个字都没有,根本无从排查。
 * 而且 messages 是用量计费的唯一依据,丢一条就是账目对不上。
 *
 * 返回落库后的 id,让调用方决定要不要在回复里如实说明。
 */
export async function insertAssistantMessage(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  row: Record<string, unknown>,
): Promise<string | null> {
  if (!supabase) return null;
  // 取回落库后的 id。
  //
  // 反馈按钮(👍/👎/我改成了这样)要用它:message_feedback.message_id 是
  // 指向 messages 的外键,而客户端手里只有一个自己造的临时 id
  // (`a-${Date.now()}`)。不把真实 id 发回去,刚生成的那条回答上
  // 点任何反馈都会被 Zod 的 uuid 校验挡下 —— 而那恰恰是唯一想打分的时刻。
  const { data, error } = await supabase
    .from("messages")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    logDbFailure("messages.insert(assistant)", error, {
      conversationId: row["conversation_id"],
      organizationId: row["organization_id"],
      model: row["model_id"],
    });
    return null;
  }
  return data.id as string;
}

/** 前置检查通过后,两条通道各自需要的一切 */
export interface TurnContext {
  readonly supabase: NonNullable<
    Awaited<ReturnType<typeof createSupabaseServerClient>>
  >;
  readonly userId: string;
  readonly organizationId: string;
  readonly conversationId: string;
  readonly providerId: string;
  readonly providerKind: string;
  readonly providerBaseUrl: string | null;
  readonly apiKeyCipher: string;
  readonly model: string;
  /** 用户自己打的那句话,不含附件与检索材料 */
  readonly content: string;
  /** 交给模型的这一轮输入:附件 + 检索材料 + 用户原话 */
  readonly userMessage: string;
  /**
   * 之前的对话,已按预算装配。
   *
   * 只有 user / assistant 两种角色 —— system 由各通道自己加:
   * 对话通道不加,智能体通道加的是 AGENT_SYSTEM_PROMPT。
   * 在这里就把类型收窄,免得哪天有人往历史里塞一条 system,
   * 智能体的系统提示词被顶掉了还查不出来。
   */
  readonly history: readonly { role: "user" | "assistant"; content: string }[];
  /** history + 本轮 userMessage,对话通道直接拿去调用 */
  readonly messages: readonly ChatMessage[];
  readonly searchNote: string | null;
  readonly trimmingNote: string | null;
  /** 实际装进上下文的项目文件数,界面要如实显示 */
  readonly filesIncluded: number;
}

export type PreflightResult =
  | { readonly ok: false; readonly response: Response }
  | { readonly ok: true; readonly ctx: TurnContext };

/**
 * 跑完一轮请求的全部前置检查,并把上下文装配好。
 *
 * @param channel 这一轮走的是哪条通道。它决定三件事:
 *   1. 限流按通道分开计数 —— 智能体一轮就是十几次上游调用,
 *      和对话共用一个计数器的话,跑一次智能体会把对话额度顺带打光,
 *      而用户完全不知道 AI 助手为什么突然说「请求过于频繁」
 *   2. 新建对话时落到哪条通道(conversations.channel,迁移 0023)
 *   3. 传入的 conversationId 必须属于同一条通道,不能跨通道续写
 */
export async function preflightTurn(
  request: Request,
  channel: "chat" | "agent",
): Promise<PreflightResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { ok: false, response: errorResponse("认证服务未配置。", 503) };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: errorResponse("登录状态已失效,请重新登录。", 401),
    };
  }

  const parsed = turnBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(
        parsed.error.issues[0]?.message ?? "请求不合法",
        400,
      ),
    };
  }

  // 限流。放在最前面 —— 越早拒绝,越少浪费。
  //
  // 这是整个系统里唯一会造成直接金钱损失的缺口:此前只校验登录,
  // 一个循环脚本就能把用户配置的服务商配额刷干,账单落在用户头上。
  const { checkRateLimit } = await import("@/lib/services/rate-limit");
  const limit = await checkRateLimit(`${channel}:${user.id}`);
  if (!limit.allowed) {
    return {
      ok: false,
      response: errorResponse(
        limit.reason ?? "请求过于频繁,请稍后再试。",
        429,
      ),
    };
  }

  const { providerId, model, content } = parsed.data;

  // 读取 Provider —— 走用户身份客户端,RLS 保证只能读到自己组织的。
  // 密文列不在这里取:迁移 0018 之后它对 authenticated 不可读了。
  const { data: provider } = await supabase
    .from("ai_providers")
    .select("id, kind, base_url, organization_id, enabled")
    .eq("id", providerId)
    .maybeSingle();

  if (!provider) {
    return { ok: false, response: errorResponse("未找到该模型服务。", 404) };
  }
  if (provider.enabled === false) {
    return { ok: false, response: errorResponse("该模型服务已停用。", 400) };
  }

  // 上面这一行能读到,就说明 RLS 认可此人有权访问这个服务商 ——
  // 授权判断完成之后,才用 service_role 取密文。顺序不能颠倒:
  // 反过来先取密文再判断,等于把 RLS 架空。
  const apiKeyCipher = await loadProviderCipher(providerId);
  if (!apiKeyCipher) {
    return {
      ok: false,
      response: errorResponse("无法读取该模型服务的密钥,请重新填写。", 500),
    };
  }

  const organizationId = provider.organization_id as string;

  // 找到或新建对话
  let conversationId = parsed.data.conversationId;

  // 客户端传来的对话 id 必须校验归属。
  //
  // RLS 只保证「用户能看到自己的对话」,不保证「这个对话和这次用的服务商
  // 属于同一个组织」。而下面写 messages 时,organization_id 取自 provider、
  // conversation_id 取自客户端 —— 两者不一致的话,消息会带着 B 组织的
  // organization_id 落进 A 组织的对话里。
  // messages 正是「后续做用量计费与权益控制的唯一依据」(迁移 0006 原话),
  // 归属错了等于计费依据被污染。
  // 检查顺序有讲究:先判组织,再判通道。
  //
  // 跨组织是**安全**问题(计费依据被污染),跨通道只是走错了页面。
  // 反过来的话,一个跨组织的请求会先撞上「请到智能体页面继续」——
  // 一句与真实原因完全无关的提示,而真正的越权反而没被说出来。
  if (conversationId) {
    const { data: conv } = await supabase
      .from("conversations")
      .select("id, organization_id, channel")
      .eq("id", conversationId)
      .maybeSingle();

    if (!conv) {
      return { ok: false, response: errorResponse("未找到该对话。", 404) };
    }
    if (conv.organization_id !== organizationId) {
      return {
        ok: false,
        response: errorResponse(
          "这个对话与所选模型服务不属于同一个组织,已拒绝。",
          400,
        ),
      };
    }

    // 通道不能跨。
    //
    // 两条通道的执行形态不同(一个无副作用、一个写工作区),历史列表也
    // 各管各的。允许跨通道续写的话,一个对话会一半是问答、一半带着工具
    // 执行记录,而它只出现在其中一个页面的列表里 —— 另一半的记录用户
    // 再也找不到。
    if (conv.channel !== channel) {
      return {
        ok: false,
        response: errorResponse(
          conv.channel === "agent"
            ? "这是一个智能体会话,请到智能体页面继续。"
            : "这是一个 AI 助手对话,请到 AI 助手页面继续。",
          400,
        ),
      };
    }

  }

  if (!conversationId) {
    const { data: created, error } = await supabase
      .from("conversations")
      .insert({
        organization_id: organizationId,
        user_id: user.id,
        title: content.slice(0, 40),
        channel,
      })
      .select("id")
      .single();

    if (error || !created) {
      return { ok: false, response: errorResponse("无法创建对话。", 500) };
    }
    conversationId = created.id as string;
  }

  // 本轮带来的附件先落到**对话**上,而不是塞进这一条消息。
  //
  // 此前附件只作用于发出的那一轮:用户贴了项目目录,第二句问「改一下这个
  // 函数」,模型已经看不到代码了 —— 那不是智能体,是失忆的聊天框。
  // 挂在对话上后,每个文件只存一份,而且每一轮都看得到。
  const incoming = parsed.data.attachments ?? [];
  if (incoming.length > 0) {
    const { error: attachError } = await supabase
      .from("conversation_attachments")
      .upsert(
        incoming.map((a) => ({
          conversation_id: conversationId,
          organization_id: organizationId,
          path: a.path,
          content: a.content,
          size_chars: a.content.length,
        })),
        { onConflict: "conversation_id,path" },
      );

    // 存不下就别往下走。
    //
    // 此前这里不检查错误:RLS 拒绝时静默失败,但模型照常被调用、
    // 配额照常消耗,而用户以为项目文件已经带上了 —— 得到的却是
    // 一个没看过代码的回答。宁可当场失败,也不能让人拿到看似正常
    // 实则缺了上下文的结果。
    if (attachError) {
      logDbFailure("conversation_attachments.upsert", attachError, {
        conversationId,
        organizationId,
        count: incoming.length,
      });
      return {
        ok: false,
        response: errorResponse(
          `项目文件未能保存,已中止本次调用(避免让你拿到一个没看过这些文件的回答):${attachError.message}`,
          500,
        ),
      };
    }
  }

  const [{ data: attachmentRows }, { data: history }] = await Promise.all([
    supabase
      .from("conversation_attachments")
      .select("path, content")
      .eq("conversation_id", conversationId)
      .order("path"),
    supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      // 取得比预算需要的多一些,由预算决定实际带多少 ——
      // 固定取 50 条是没有依据的数字,长对话照样会越来越贵
      .limit(200),
  ]);

  // 联网检索。开启时先搜,再把结果连同来源交给模型 ——
  // 模型本身没有联网能力,平台自带的搜索按钮是平台功能,
  // 通过 OpenAI 兼容接口调用时拿不到。所以这一步必须我们自己做。
  //
  // 搜索失败不中断对话:模型基于既有知识作答并说明没搜到,
  // 比整轮报错有用。
  let searchBlock = "";
  let searchNote: string | null = null;
  if (parsed.data.webSearch === true) {
    const { data: integration } = await supabase
      .from("integrations")
      .select("id, kind, enabled")
      .eq("organization_id", organizationId)
      .eq("kind", "tavily")
      .maybeSingle();

    if (!integration || integration.enabled === false) {
      searchNote =
        "未配置搜索集成,本轮未联网。可在「集成」页添加 Tavily 密钥后开启。";
    } else {
      const { tavilySearch, renderSearchContext } = await import(
        "@/lib/integrations/tavily"
      );
      // 同样是先判权(上面那次查询过了 RLS)再取密文
      const cipher = await loadIntegrationCipher(integration.id as string);
      const outcome = cipher
        ? await tavilySearch({ credentialCipher: cipher, query: content })
        : {
            ok: false,
            results: [],
            error: "无法读取检索服务的密钥,请到「集成」页重新填写。",
          };
      if (outcome.ok && outcome.results.length > 0) {
        searchBlock = renderSearchContext(content, outcome.results);
        searchNote = `已联网检索 ${outcome.results.length} 条结果,回答中的来源编号对应这些链接。`;
      } else {
        searchNote = outcome.ok
          ? "本轮联网检索没有找到相关结果,以下回答基于模型既有知识。"
          : `联网检索失败(${outcome.error ?? "未知原因"}),以下回答基于模型既有知识。`;
      }
    }
  }

  // 在预算内装配上下文:先保项目文件(智能体干活的依据),
  // 剩余额度给历史消息,历史从最近往前装。
  // 装不下的如实统计,由界面告知用户 —— 静默截断会让模型看到残缺信息,
  // 给出的建议全是错的,比不带更糟。见 lib/ai/context.ts。
  const { buildContext, describeTrimming } = await import("@/lib/ai/context");
  const built = buildContext(
    (attachmentRows ?? []).map((r) => ({
      path: r.path as string,
      content: r.content as string,
    })),
    (history ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: (m.content as string | null) ?? "",
    })),
  );
  const trimmingNote = describeTrimming(built.stats);

  const userMessage = `${built.fileBlock}${searchBlock}${content}`;

  // 先落库用户消息 —— 即便后续模型调用失败,用户说过的话也不该丢。
  // 存的是用户自己打的字,不含附件正文。
  const { error: userMsgError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    organization_id: organizationId,
    role: "user",
    content,
  });

  // 用户消息都存不下,说明这次请求的写权限有问题 —— 继续调用模型只会
  // 让对话记录出现「有回答没有提问」的断裂,而且钱照花。当场失败。
  if (userMsgError) {
    logDbFailure("messages.insert(user)", userMsgError, {
      conversationId,
      organizationId,
    });
    return {
      ok: false,
      response: errorResponse(
        `消息未能保存,已中止本次调用:${userMsgError.message}`,
        500,
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      supabase,
      userId: user.id,
      organizationId,
      conversationId,
      providerId,
      providerKind: provider.kind as string,
      providerBaseUrl: provider.base_url as string | null,
      apiKeyCipher,
      model,
      content,
      userMessage,
      history: built.messages,
      messages: [...built.messages, { role: "user" as const, content: userMessage }],
      searchNote,
      trimmingNote,
      filesIncluded: built.stats.filesIncluded,
    },
  };
}
