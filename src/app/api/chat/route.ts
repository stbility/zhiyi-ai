import type { NextRequest } from "next/server";

import {
  explainEmptyResponse,
  ProviderCallError,
  streamChat,
} from "@/lib/ai/gateway";
import { logger } from "@/lib/log";
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
// 显式声明,避免依赖平台默认值。Vercel 官方文档:Hobby 计划默认 300 秒、
// 上限同样是 300 秒,调不高。
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
 * 唯一还留着的时限是平台强制的那个:Vercel 的函数最长 300 秒,调不高。
 * 看门狗的真正价值从来不是「早点掐断」,而是**在撞上平台上限之前主动收尾,
 * 把原因说清楚** —— 被平台强杀时连接直接断开,浏览器只报「Failed to fetch」,
 * 用户完全不知道发生了什么。所以机制保留,阈值只剩平台那一个。
 *
 * 产品定位上也是这个道理:用户用自己的密钥、自己付费,
 * 我们没有立场替他决定「等多久算太久」。
 */
const TOTAL_BUDGET_MS = 285_000;
/**
 * 一次请求最多换几个模型。
 *
 * 排队时自动降级是「长期稳定执行任务」的关键,但不能无限换 —— 总预算是
 * 共享的,换太多次只会让用户干等到超时,还不如早点如实报错。
 */
const MAX_MODEL_ATTEMPTS = 3;

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
  } = pre.ctx;

  const startedAt = Date.now();

  // 取候选模型,排出降级链。
  //
  // 用户要的是「长期稳定执行任务」,而共享算力上的模型排队是常态,不是故障。
  // 稳定不能靠挑一个永不排队的模型(不存在),只能靠排队时自动换一个。
  //
  // 候选跨**整个组织的全部服务商**,不再限于用户选中的那一个。
  // 此前这里是 .eq("provider_id", providerId) —— 三个候选全在同一家,
  // 而一家的容量塌陷是整体性的:英伟达堵的时候它上面的
  // deepseek-ai/…、z-ai/…、moonshotai/… 一起堵(vendorOf 按 `/` 前缀
  // 把它们看成三个厂商,其实是同一个算力池)。于是「换一个模型」换了等于没换,
  // 而用户配好的 DeepSeek 官方一次都没被试过。见 lib/ai/candidates.ts。
  const { loadOrgCandidates, orderCandidates, createCredentialLoader, describeSwitch } =
    await import("@/lib/ai/candidates");

  const chain = orderCandidates(
    await loadOrgCandidates(supabase, organizationId),
    providerId,
    model,
  ).slice(0, MAX_MODEL_ATTEMPTS);

  const credentialsFor = createCredentialLoader();
  /** 用户最初选的那个,用于降级说明里的「从哪换到哪」 */
  const requested = {
    providerName:
      chain.find((c) => c.providerId === providerId)?.providerName ?? "所选服务",
    modelId: model,
  };

  const { indicatesModelUnusable, isTransientFailure } = await import(
    "@/lib/providers/model-filter"
  );

  let result: Awaited<ReturnType<typeof streamChat>> | null = null;
  let watchdog: ReturnType<typeof createStallWatchdog> | null = null;
  /** 实际用上的模型,可能不是用户选的那个 */
  let actualModel = model;
  /** 实际用上的服务商 —— 换了服务商就必须按新的那个留痕,否则用量归属是错的 */
  let actualProviderId = providerId;
  /** 降级说明。发生了就必须告诉用户 —— 悄悄换模型等于伪造来源 */
  let fallbackNote: string | null = null;
  let lastFailure = "调用模型服务失败。";
  let lastStatus: number | undefined;
  /** 真正发起过请求的模型 —— 报错文案只能提这些,不能提整条候选链 */
  const attempted: string[] = [];
  /** 已确认整体不可用的服务商(密钥失效等),同一家的其余候选直接跳过 */
  const deadProviders = new Set<string>();

  for (const candidate of chain) {
    // 这家已经确认不可用,同一把密钥换个模型结果一样,不必再烧一次调用
    if (deadProviders.has(candidate.providerId)) continue;

    // 总预算是整次请求共享的,不是每个模型各给一份 —— 否则四个模型轮下来
    // 早就撞上平台的函数时限了
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    // 只要还有时间就试。此前是「剩余不足 45 秒就放弃」——
    // 那是拿一个人为阈值提前否掉一次本来可能成功的调用
    if (remaining <= 0) break;

    const wd = createStallWatchdog(
      remaining,
      `本次生成已达到平台单次请求的时长上限(${Math.round(TOTAL_BUDGET_MS / 1000)} 秒),已中止。\n` +
        `这不是网络故障 —— Vercel 的函数最长只能运行 300 秒。\n` +
        `如果任务本身很长(比如生成整个项目),请拆成几步分别提问;` +
        `长时间运行的任务需要工作流引擎在后台执行。`,
      request.signal,
    );

    attempted.push(candidate.modelId);

    // 每个候选用**它自己服务商**的密钥。
    // 拿 A 家的 key 去调 B 家的模型只会得到 401 —— 跨服务商降级的前提
    // 就是凭据也跟着换。
    const candidateCreds = await credentialsFor(candidate);
    if (!candidateCreds) {
      wd.clear();
      lastFailure = `无法读取「${candidate.providerName}」的密钥,已跳过。`;
      logger.warn(
        { providerId: candidate.providerId, organizationId },
        "候选服务商密钥不可读,跳过",
      );
      continue;
    }

    try {
      result = await streamChat({
        credentials: candidateCreds,
        model: candidate.modelId,
        messages,
        signal: wd.signal,
      });
      watchdog = wd;
      actualModel = candidate.modelId;
      actualProviderId = candidate.providerId;
      if (candidate.providerId !== providerId || candidate.modelId !== model) {
        fallbackNote = describeSwitch(requested, candidate, lastFailure);
      }
      break;
    } catch (e) {
      wd.clear();

      // 客户端自己断开了,没人在等回复,换模型重试毫无意义
      if (request.signal.aborted) return errorResponse("请求已取消。", 499);

      lastStatus = e instanceof ProviderCallError ? e.status : undefined;
      lastFailure =
        wd.reason ??
        (e instanceof ProviderCallError ? e.message : "调用模型服务失败。");

      // 只记录失败原因,不再把模型从可选列表里摘掉。
      //
      // 早先是「永久性失败即标记不可用」,结果把用户真正需要的模型悄悄拿走了 ——
      // Kimi 就是这种情况:服务商目录里有、代理编程要用,只是这个账号
      // 暂时没被授权。系统不该替用户做这个决定。
      // 本次调用会由下面的降级链换一个模型完成,任务不中断。
      // 模型调用失败是最需要事后排查的一类:用户只会说「模型不工作」,
      // 而真正的原因(密钥被吊销、账号没开通、上游排队)全在这条日志里。
      // 此前全站没有日志,每次都只能靠翻数据库里的 error_message 反推。
      logger.warn(
        {
          model: candidate.modelId,
          providerId: candidate.providerId,
          organizationId,
          status: lastStatus,
          reason: lastFailure,
        },
        "模型调用失败",
      );

      if (indicatesModelUnusable(lastStatus, lastFailure)) {
        await supabase
          .from("ai_models")
          .update({ last_error: lastFailure })
          .eq("provider_id", candidate.providerId)
          .eq("model_id", candidate.modelId);
      }

      // 永久性失败:跳过**同一个服务商**的其余候选,但继续试别的服务商。
      //
      // 密钥被拒(401/403)是整个服务商级别的问题,同一把密钥换几个模型
      // 结果完全一样 —— 白烧三次调用,最后的报错还像是模型的问题,
      // 把用户引去怀疑模型,而问题在密钥。
      //
      // 但此前这里是直接 break 掉整条链。那在「候选全在同一家」的年代是对的,
      // 现在候选跨服务商:A 家的密钥失效不能成为「B 家也不试」的理由 ——
      // 那会让一把过期的旧密钥把整个组织的对话能力全部堵死。
      if (!isTransientFailure(lastStatus, lastFailure)) {
        deadProviders.add(candidate.providerId);
      }
      // 临时性失败(排队、限流、5xx)才继续尝试链上的下一个模型
    }
  }

  if (result === null || watchdog === null) {
    // 全链路都没成功。留痕时记的是用户原本选的模型 —— 那才是他的意图。
    // 只有真的轮过多个模型才提「依次尝试」。鉴权失败时我们在第一个就停了,
    // 却说「已依次尝试 3 个模型」,等于把用户引去怀疑模型 —— 而问题在密钥。
    const message =
      attempted.length > 1
        ? `${lastFailure}(已依次尝试 ${attempted.length} 个模型:${attempted.join("、")})`
        : lastFailure;

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

    return errorResponse(
      message,
      isTransientFailure(lastStatus, lastFailure) ? 504 : 502,
    );
  }

  // 收窄成 const,闭包里才拿得到非空类型
  const chosen = result;
  // 换过服务商时必须按**实际用上的**那个留痕:messages 是用量计费的唯一依据,
  // 记成用户最初选的那家,账就算到了没干活的服务商头上。
  const usedProviderId = actualProviderId;
  const wd = watchdog;
  const usedModel = actualModel;
  const note = fallbackNote;

  const encoder = new TextEncoder();
  const convId = conversationId;
  const trimming = trimmingNote;
  const search = searchNote;
  const fileCount = filesIncluded;

  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let full = "";

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
        ...(note ? { fallback: note } : {}),
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
        for await (const chunk of chosen.stream) {

          if (chunk.kind === "reasoning") {
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
          const reason = explainEmptyResponse(chosen.diagnostics);

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
          content: full,
          provider_id: usedProviderId,
          model_id: usedModel,
          input_tokens: chosen.usage.inputTokens,
          output_tokens: chosen.usage.outputTokens,
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
          inputTokens: chosen.usage.inputTokens,
          outputTokens: chosen.usage.outputTokens,
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
            content: full,
            provider_id: usedProviderId,
            model_id: usedModel,
            latency_ms: Date.now() - startedAt,
            error_message: message,
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
