import type { NextRequest } from "next/server";

import {
  explainEmptyResponse,
  ProviderCallError,
  streamChat,
  type ProviderCredentials,
} from "@/lib/ai/gateway";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/log";
import {
  isPlatformProviderId,
  loadPlatformCandidates,
} from "@/lib/ai/platform-models";
import { createStallWatchdog } from "@/lib/ai/stall-watchdog";
import {
  errorResponse,
  insertAssistantMessage,
  preflightTurn,
} from "@/lib/ai/turn-preflight";

/**
 * AI 助手的流式对话接口。**只管对话,不碰工作区。**
 *
 * 智能体在另一条通道:/api/agent。分开的理由见 lib/ai/turn-preflight.ts ——
 * 简单说就是 Claude 的分法:claude.ai 是思考伙伴,Claude Code 是工程师,
 * 两个真正不同的产品,默认能力面完全不同。
 *
 * 这条路由此前靠请求体里一个 `agent: true` 分岔到智能体循环,
 * 于是「改一条弄坏另一条」反复发生。现在分岔点在路由层,不在函数里。
 *
 * 数据流向:客户端 → 本路由 → 模型服务商 → 逐字回传客户端。
 * 密钥全程只在服务端出现,解密后立即用于请求,不写日志、不回传浏览器。
 *
 * 每次调用都会落库留痕:用了哪个 Provider、哪个模型、耗时、token 用量。
 * 失败同样落库并记下原因 —— 失败的调用也是发生过的事实,不能假装没发生。
 */

export const runtime = "nodejs";
// 流式响应不能被缓存
export const dynamic = "force-dynamic";
// 平台给这条路由多长时间,**由这一个数决定**,全链路都从它推导。
//
// 300 是 Hobby 计划的上限。它**不是**绝对上限 —— Vercel 官方文档:
// Pro/Enterprise 开启 Fluid compute 可到 800 秒,支持的 Node 运行时
// 还能开到 1800 秒(beta)。换计划时只改这一个数。
// 我此前在注释里反复写「调不高」,那是错的,而且会让人以为没有出路。
// https://vercel.com/docs/functions/configuring-functions/duration
export const maxDuration = 300;

/**
 * 超时预算。
 *
 * 真实故障:三次失败落库的耗时分别是 296234 / 298105 / 296548 毫秒 ——
 * 全部贴着 300 秒。原因是网关对上游 fetch 没有任何超时,服务商排队不回应时
 * 就一直挂着,直到 Vercel 把函数强杀。函数被杀 = 连接被掐断,浏览器只能报
 * 「Failed to fetch」,用户完全不知道发生了什么。
 *
 * 所以必须在撞上限之前主动失败,把原因说清楚。
 */
/*
 * 这里曾有两个人为时限:首片 45 秒、停滞 60 秒。两个都删了。
 *
 * 它们杀掉的是**正在正常工作**的请求。推理模型(deepseek-v4-pro 这类)
 * 会先思考很久才吐第一个字,而思考过程要服务商吐 reasoning_content
 * 我们才收得到 —— NVIDIA 的部署未必开着。于是一次正常的推理调用
 * 在第 45 秒被判成「模型正在排队」直接掐断,用户看到的是「模型不能用了」。
 *
 * 唯一还留着的时限是平台强制的那个:函数跑到 maxDuration 就被杀。
 * 看门狗的真正价值从来不是「早点掐断」,而是**在撞上平台上限之前主动收尾,
 * 把原因说清楚** —— 被平台强杀时连接直接断开,浏览器只报「Failed to fetch」,
 * 用户完全不知道发生了什么。所以机制保留,阈值只剩平台那一个。
 *
 * 产品定位上也是这个道理:用户用自己的密钥、自己付费,
 * 我们没有立场替他决定「等多久算太久」。
 */
/**
 * 收尾预算 —— **由 maxDuration 推导,不写死任何秒数**。
 *
 * 平台给多长时间由上面那个 maxDuration 决定,而它是 Vercel 的配置旋钮:
 * Hobby 是 300 秒;Pro/Enterprise 开 Fluid compute 可到 800 秒;
 * 支持的 Node 运行时还能开到 1800 秒(beta)。
 * 换计划就改那**一个**数,这里自动跟着走 —— 我不再另写一个秒数。
 *
 * 减掉的那点是**写记录用的**,不是给模型的时限:平台到点直接杀进程,
 * 连接断开、浏览器只报 Failed to fetch,用户连发生了什么都看不到。
 * 留出这点时间是为了把原因写进库。
 */
const TOTAL_BUDGET_MS = maxDuration * 1000 - 15_000;
/*
 * MAX_MODEL_ATTEMPTS 已删,连同整条自动降级链。
 *
 * 用户的原话:「你不要设置任何模型」「你选哪个就用哪个」。
 * 自动换模型在这个产品里是错的 —— 他用自己的密钥、自己付费,
 * 选哪个模型是他的决定。而且换过之后留痕和界面会各说一个模型名,
 * 从他那一侧和编造无法区分(生产上真的发生过)。
 *
 * 智能体那条线 08-03 就删了,对话这条线现在跟上。
 */

export async function POST(request: NextRequest) {
  // 鉴权、限流、服务商与对话归属、附件落库、上下文装配、用户消息留痕 ——
  // 两条通道一字不差地都要做,所以共用同一个实现。见 lib/ai/turn-preflight.ts。
  const pre = await preflightTurn(request, "chat");
  if (!pre.ok) return pre.response;
  const {
    supabase,
    organizationId,
    conversationId,
    providerId,
    model,
    messages,
    searchNote,
    trimmingNote,
    filesIncluded,
    apiKeyCipher: cipher,
  } = pre.ctx;

  const startedAt = Date.now();

  // 取候选模型,排出降级链。
  //
  // **用户选哪个服务商、哪个模型,就用哪个。不换。**
  //
  // 这里曾经是一条跨服务商的自动降级链:排队就换下一个接着跑。
  // 删掉了,用户的原话是「你不要设置任何模型」「我使用」——
  // 他用自己的密钥、自己付费,选哪个是他的决定,不是我们的。
  //
  // 而且自动换在生产上造成过更糟的事:留痕记的是他选的那个,
  // 正文里写着换过别的,同一条记录两个模型名 —— 从他那一侧看,
  // 这和编造无法区分。智能体那条线 08-03 删了,对话这条线现在跟上。
  // 平台免费档的模型不在 ai_providers 里 —— 它没有属于任何组织的行。
  //
  // 这一支必须走**同一个** loadPlatformCandidates:授权判定(free_only、
  // 环境变量配没配、模型有没有下架)只能有一处实现。在这里另写一遍
  // 「是平台模型就放行」,等于给免费档开了一个不受档位约束的后门。
  const credentials = isPlatformProviderId(providerId)
    ? await platformCredentialsFor(supabase, organizationId, providerId, model)
    : await byokCredentials(supabase, organizationId, providerId, cipher);

  if (!credentials) {
    return errorResponse(
      isPlatformProviderId(providerId)
        ? "这个模型当前不可用。它属于平台免费档 —— 可能是服务端未配置密钥,或你的组织不在该档位。"
        : "这个服务商当前不可用。请到「模型服务」确认它已启用。",
      503,
    );
  }

  // 这不是时限,是**收尾信号**。
  //
  // 平台会在 maxDuration 到点时直接杀进程 —— 连接断开,浏览器只报
  // 「Failed to fetch」,已经生成的内容全部丢失。这个信号提前一点点触发,
  // 唯一作用是把**已经收到的内容存下来交给用户**。
  //
  // 它不再产生任何报错文案:用户看到的是模型已经写出来的那部分,
  // 不是一句「已达到 X 秒上限」。那句话曾经变成我解释「模型不工作」的
  // 挡箭牌 —— 而真正的问题是上游吞吐,不是这个数字。
  const wd = createStallWatchdog(
    TOTAL_BUDGET_MS - (Date.now() - startedAt),
    "",
    request.signal,
  );

  // 上游临时故障要**重试同一个模型**,不是换模型,也不是直接失败。
  //
  // 529 overloaded 的字面意思就是「忙,等会儿再来」—— 它恰恰是最该重试的
  // 一种。我几分钟前删自动降级链时把重试也一并删掉了,于是一个 529 就
  // 让整次对话直接失败,一次都不试。那是我弄坏的,不是用户要的:
  // 他说的是「不换模型」,不是「不重试」。
  //
  // 做法照 Claude Code 官方文档(code.claude.com/docs/en/errors):
  //   「Claude Code retries these failures: Server errors, overloaded
  //    responses, and request timeouts … Temporary 429 throttles.」
  // 指数退避,重试用尽之前不把错误给用户看。
  //
  // 次数不设上限 —— 界限只有剩余预算:退避时间超过剩余预算时就停。
  const { isTransientFailure } = await import("@/lib/providers/model-filter");

  let result: Awaited<ReturnType<typeof streamChat>>;
  let attempt = 0;
  for (;;) {
    try {
      result = await streamChat({
        credentials,
        model,
        messages,
        signal: wd.signal,
      });
      break;
    } catch (e) {
      if (request.signal.aborted) {
        wd.clear();
        return errorResponse("请求已取消。", 499);
      }

      const err =
        e instanceof ProviderCallError
          ? e
          : new ProviderCallError(
              `与模型服务的连接中断:${e instanceof Error ? e.message : String(e)}`,
            );
      // 传输层断了(fetch failed、连接被重置)按临时故障处理 ——
      // 它没有状态码可判,但按定义就是临时的
      const 断连 = !(e instanceof ProviderCallError);

      // 平台时限到了就是到了,重试也没有时间跑
      const 剩余 = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      const 可重试 =
        !wd.reason &&
        剩余 > 0 &&
        (断连 || isTransientFailure(err.status, err.message));

      if (可重试) {
        // 指数退避 1s / 2s / 4s / 8s 封顶。等待时间超过剩余预算就别等了 ——
        // 睡过去只会被平台强杀,连报错都送不出去。
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        if (backoff < 剩余) {
          attempt += 1;
          logger.warn(
            { model, providerId, attempt, status: err.status, backoffMs: backoff },
            "上游临时失败,退避后重试同一个模型",
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
      }

      wd.clear();
      // 上游说什么就是什么,不加推断、不替它解释。
      const message = wd.reason ?? err.message;
      logger.warn({ model, providerId, organizationId, reason: message }, "模型调用失败");

      await insertAssistantMessage(supabase, {
        conversation_id: conversationId,
        organization_id: organizationId,
        role: "assistant",
        content: "",
        provider_id: providerId,
        model_id: model,
        latency_ms: Date.now() - startedAt,
        error_message: message,
      });
      return errorResponse(message, 502);
    }
  }

  const usedProviderId = providerId;
  const usedModel = model;

  const encoder = new TextEncoder();
  const convId = conversationId;
  const trimming = trimmingNote;
  const search = searchNote;
  const fileCount = filesIncluded;

  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let full = "";
      /** 已收到的思考过程。正文为空时用它落库,免得几分钟的输出化为乌有 */
      let reasoningSoFar = "";

      // 客户端一旦断开(关页面、切走、网络掉线),enqueue/close 会抛
      // 「Invalid state」。这个抛出发生在 start() 里,会让整个函数以未处理异常
      // 收场 —— 服务端记成一次崩溃,后续的留痕代码也不再执行。
      // 客户端走掉是正常情况,不是服务端错误,所以这里全部吞掉。
      let clientGone = false;
      const send = (event: string, data: unknown) => {
        if (clientGone) return;
        try {
          streamController.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          clientGone = true;
        }
      };

      // 先把对话 id 告知客户端,便于后续消息挂到同一对话。
      // 若发生了降级,一并说明用的其实是哪个模型 —— 悄悄换等于伪造来源。
      send("meta", {
        conversationId: convId,
        model: usedModel,
        // 上下文被裁剪时如实告知 —— 静默截断会让用户以为模型「忘了」,
        // 实际上是我们没把内容发过去
        ...(trimming ? { trimming } : {}),
        // 本对话当前关联的项目文件数,让用户知道智能体看得到什么
        ...(fileCount > 0 ? { files: fileCount } : {}),
        // 联网与否、搜到没搜到,都要如实说 —— 不说的话用户无从判断
        // 这个回答到底是基于实时资料还是模型的旧知识
        ...(search ? { search } : {}),
      });

      try {
        for await (const chunk of result.stream) {

          if (chunk.kind === "reasoning") {
            // 留一份。**这是被超时丢掉过的东西。**
            //
            // gateway 里那段「整轮没有正文就把思考过程交出来」的兜底
            // 写在 for-await 循环**之后**;而被平台打断时,
            // 循环是抛异常退出的 —— 那段兜底根本不会执行。
            // 于是模型思考了近五分钟,落库的 content 只有两个字。
            //
            // 在这里留一份,就与流怎么结束无关了:正常结束、超时中止、
            // 连接断开,已经收到的思考过程都还在手上。
            reasoningSoFar += chunk.text;
            // 思考过程实时推给前端,但**不计入正文** ——
            // 它证明模型在工作,却不是给用户的答案。
            //
            // 此前它被整段缓冲、只在完全没有正文时才吐出来,后果是:
            // 推理模型思考的几分钟里前端一个字都收不到,界面看起来是死的;
            // 而看门狗只在收到增量时重新计时,于是模型正常思考却被判成
            // 「45 秒没有返回任何内容」直接掐断。
            send("reasoning", { text: chunk.text });
          } else {
            full += chunk.text;
            send("delta", { text: chunk.text });
          }
          // 思考也算「在动」—— 正在推理的模型不该被当成卡住
          // 收到增量不再重新 arm 一个人为的停滞阈值 ——
          // 总预算那个定时器一直在跑,它才是唯一的界限
        }
        wd.clear();

        // 上游返回 200 却一个字都没产出 —— 这是失败,不是「成功但内容为空」。
        // 以前这里静默存成空消息,用户看到空气泡,数据库里也查不出原因。
        if (full === "") {
          const reason = explainEmptyResponse(result.diagnostics);

          await insertAssistantMessage(supabase, {
            conversation_id: convId,
            organization_id: organizationId,
            role: "assistant",
            content: "",
            provider_id: usedProviderId,
            model_id: usedModel,
            latency_ms: Date.now() - startedAt,
            error_message: reason,
          });

          send("error", { message: reason });
          return;
        }

        const saved = await insertAssistantMessage(supabase, {
          conversation_id: convId,
          organization_id: organizationId,
          role: "assistant",
          // 一个字正文都没有时,存思考过程 —— 它同样是**模型自己的输出**,
          // 不是我们写的东西。丢掉它等于让用户白等。
          content: full !== "" ? full : reasoningSoFar,
          provider_id: usedProviderId,
          model_id: usedModel,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          latency_ms: Date.now() - startedAt,
        });

        // 存不下就当场说清楚。用户刚看着这段回答生成出来,
        // 下次进来却发现它不见了 —— 那比一开始就报错更让人无法理解。
        if (!saved) {
          send("error", {
            message:
              "这条回答没能保存到对话记录里(刷新后会看不到)。内容还在上面,需要的话请先自行复制。",
          });
        }

        // 这次真的成功了,清掉上次的失败留痕 ——
        // 否则一条早已过时的报错会一直挂在模型旁边,与事实相反。
        await supabase
          .from("ai_models")
          .update({ last_error: null })
          .eq("provider_id", providerId)
          .eq("model_id", usedModel);

        send("done", {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: Date.now() - startedAt,
          // 真实的消息 id,客户端据此把临时 id 换掉,反馈按钮才点得动
          ...(saved ? { messageId: saved } : {}),
        });
      } catch (e) {
        // 看门狗掐断的,原因比 AbortError 有用得多
        const message =
          wd.reason ??
          (e instanceof ProviderCallError
            ? e.message
            : "生成过程中断,请重试。");

        // 中断时把已生成的部分连同错误一起留痕,不丢用户已看到的内容。
        // 留痕失败(比如连不上数据库)不能再把兜底路径本身炸掉 ——
        // 否则用户连错误提示都收不到,只会看到连接莫名断开。
        try {
          await insertAssistantMessage(supabase, {
            conversation_id: convId,
            organization_id: organizationId,
            role: "assistant",
            // 中断路径同样兜底 —— 不兜的话,等了几分钟的用户拿到的
            // 就是一个空气泡。
            content: full !== "" ? full : reasoningSoFar,
            provider_id: usedProviderId,
            model_id: usedModel,
            latency_ms: Date.now() - startedAt,
            // 已经有内容时不记错误:那是一次**被平台打断的正常生成**,
            // 不是失败。记成错误会让界面把它渲染成红色报错,
            // 而用户手里明明有模型写出来的东西。
            ...((full !== "" || reasoningSoFar !== "") ? {} : { error_message: message }),
          });
        } catch {
          // 忽略:告知用户比留痕更要紧
        }

        send("error", { message });
      } finally {
        wd.clear();
        try {
          streamController.close();
        } catch {
          // 客户端已断开时 close 会抛,同样不算服务端错误
        }
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关闭反向代理缓冲,否则流会被攒着一次性发出,失去逐字效果
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * 平台免费档的凭据。
 *
 * 必须**重新走一遍授权判定**(free_only、环境变量、模型是否下架),
 * 不能因为 providerId 长得像平台标识就放行 —— 那个标识是客户端传上来的,
 * 而客户端传什么都不能构成授权。
 */
async function platformCredentialsFor(
  supabase: SupabaseClient,
  organizationId: string,
  providerId: string,
  modelId: string,
): Promise<ProviderCredentials | null> {
  const { data: org } = await supabase
    .from("organizations")
    .select("free_only")
    .eq("id", organizationId)
    .maybeSingle();

  // 读不到时按免费档处理 —— 出错时选代价小的默认值
  const list = await loadPlatformCandidates(supabase, org?.free_only !== false);
  const hit = list.find(
    (c) => c.providerId === providerId && c.modelId === modelId,
  );
  if (!hit) return null;

  return {
    kind: hit.kind,
    baseUrl: hit.baseUrl,
    apiKeyCipher: hit.apiKeyCipher,
  };
}

async function byokCredentials(
  supabase: SupabaseClient,
  organizationId: string,
  providerId: string,
  cipher: string,
): Promise<ProviderCredentials | null> {
  const { data: providerRow } = await supabase
    .from("ai_providers")
    .select("kind, base_url, enabled")
    .eq("id", providerId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!providerRow || providerRow.enabled === false) return null;
  return {
    kind: providerRow.kind as ProviderCredentials["kind"],
    baseUrl: providerRow.base_url as string | null,
    apiKeyCipher: cipher,
  };
}
