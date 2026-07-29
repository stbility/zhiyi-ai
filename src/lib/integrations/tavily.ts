import "server-only";

import { decryptSecret } from "@/lib/crypto/secret-box";

/**
 * Tavily 搜索适配器。
 *
 * 为什么用外部搜索服务而不是「让模型自己上网」:模型本身没有联网能力。
 * 各家平台自带的搜索按钮是**平台功能**,通过 OpenAI 兼容接口调用时拿不到。
 * 所以联网必须由我们自己完成:检索 → 把结果连同来源交给模型 → 模型据实作答。
 *
 * 这样做还有个好处:搜索能力挂在网关上,与具体模型无关 ——
 * 任何服务商的任何模型都能用,换模型不影响联网,新增服务商也不必改这里。
 *
 * 官方规格:POST https://api.tavily.com/search,Bearer 鉴权。
 * https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

const ENDPOINT = "https://api.tavily.com/search";

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly content: string;
}

export interface SearchOutcome {
  readonly ok: boolean;
  readonly results: readonly SearchResult[];
  /** 失败原因,含服务商原话。成功时为 null */
  readonly error: string | null;
}

/** 单次检索的等待上限 —— 搜索卡住不该拖垮整轮对话 */
const TIMEOUT_MS = 15_000;

/**
 * 执行一次检索。
 *
 * 失败不抛错,而是返回 ok:false 加原因 —— 搜索失败时对话应当继续
 * (模型基于自身知识作答并说明「没搜到」),而不是整轮报错。
 */
export async function tavilySearch({
  credentialCipher,
  query,
  maxResults = 6,
}: {
  credentialCipher: string;
  query: string;
  maxResults?: number;
}): Promise<SearchOutcome> {
  let apiKey: string;
  try {
    apiKey = decryptSecret(credentialCipher);
  } catch {
    return { ok: false, results: [], error: "搜索密钥无法解密,请重新配置。" };
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        // basic 足够日常问答,advanced 更贵更慢;时效性问题靠 topic 保证
        search_depth: "basic",
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // 保留服务商原话 —— 只说「搜索失败」等于把唯一的线索丢掉,
      // 这个教训在模型调用那边已经吃过一次
      let detail = "";
      try {
        const body = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
        if (body.trim() !== "") detail = `。服务商原话:${body}`;
      } catch {
        // 读不到就算了
      }
      const hint =
        response.status === 401 || response.status === 403
          ? "搜索密钥被拒绝,请到「集成」检查密钥"
          : `搜索服务返回 HTTP ${response.status}`;
      return { ok: false, results: [], error: `${hint}${detail}` };
    }

    const payload = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };

    const results = (payload.results ?? []).flatMap((r) =>
      typeof r.url === "string" && r.url !== ""
        ? [
            {
              title: r.title ?? r.url,
              url: r.url,
              content: r.content ?? "",
            },
          ]
        : [],
    );

    return { ok: true, results, error: null };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return {
      ok: false,
      results: [],
      error: timedOut
        ? `搜索超过 ${Math.round(TIMEOUT_MS / 1000)} 秒未返回`
        : "无法连接搜索服务",
    };
  }
}

/**
 * 把检索结果拼成给模型看的上下文。
 *
 * 必须带上 URL:模型据此在回答里标注来源,用户才能核实。
 * 不带来源的「联网回答」和编造无异 —— 那正是这个功能要解决的问题。
 */
export function renderSearchContext(
  query: string,
  results: readonly SearchResult[],
): string {
  if (results.length === 0) return "";

  const body = results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n来源:${r.url}\n${r.content}`,
    )
    .join("\n\n");

  return (
    `以下是针对「${query}」的实时检索结果(共 ${results.length} 条)。\n` +
    `请基于这些材料作答,并在引用处标注来源编号;` +
    `材料中没有提到的内容,请明确说明是你的既有知识而非检索所得。\n\n` +
    `${body}\n\n---\n\n`
  );
}
