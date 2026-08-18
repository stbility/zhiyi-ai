/**
 * Embedding 服务(OpenAI 兼容 /embeddings 端点)。
 *
 * 基线(2026-08-18):NVIDIA Nemotron 3 Embed 1B,2048 维,官方免费端口。
 *   - 模型:EMBEDDINGS_MODEL 默认 nvidia/nemotron-3-embed-1b
 *   - Nemotron 强制区分 input_type:
 *       · 记忆沉淀/写入 → input_type=passage(embedText)
 *       · 语义召回/查询 → input_type=query(embedQuery)
 *   - 未配置时返回 null —— 调用方如实降级(召回回到「最近优先」,
 *     沉淀时不写向量),绝不假装向量可用。失败也是观察结果:
 *     记日志、返回 null,不阻断沉淀与召回主流程。
 *
 * 注意:本模块不带 server-only 守卫 —— 纯函数 + fetch,测试可直接导入;
 * 调用方(memories.ts / agent-turn)都在服务端,env 不会进客户端产物。
 */

export interface EmbeddingsConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export const DEFAULT_EMBEDDINGS_MODEL = "nvidia/nemotron-3-embed-1b";

export function getEmbeddingsConfig(): EmbeddingsConfig | null {
  const apiUrl = process.env["EMBEDDINGS_API_URL"]?.trim();
  const apiKey = process.env["EMBEDDINGS_API_KEY"]?.trim();
  if (!apiUrl || !apiKey) return null;
  return {
    apiUrl,
    apiKey,
    model:
      process.env["EMBEDDINGS_MODEL"]?.trim() || DEFAULT_EMBEDDINGS_MODEL,
  };
}

/**
 * 批量生成向量。
 * @param inputType "passage"(沉淀写入)或 "query"(召回查询)——
 *   Nemotron 强制区分,OpenAI 兼容端点忽略该字段。
 */
export async function embedTexts(
  texts: readonly string[],
  inputType: "passage" | "query" = "passage",
): Promise<number[][] | null> {
  const config = getEmbeddingsConfig();
  if (!config) return null;
  if (texts.length === 0) return [];

  try {
    const res = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        input_type: inputType,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { embedding?: number[] }[];
    };
    // 响应按输入顺序返回 —— 不排序,直接映射
    const vectors = (data.data ?? [])
      .map((d) => d.embedding)
      .filter((e): e is number[] => Array.isArray(e));
    return vectors.length === texts.length ? vectors : null;
  } catch {
    return null;
  }
}

/** 单条文本向量(沉淀/写入时用,input_type=passage) */
export async function embedText(text: string): Promise<number[] | null> {
  const vectors = await embedTexts([text], "passage");
  return vectors?.[0] ?? null;
}

/** 单条查询向量(召回时用,input_type=query) */
export async function embedQuery(text: string): Promise<number[] | null> {
  const vectors = await embedTexts([text], "query");
  return vectors?.[0] ?? null;
}
