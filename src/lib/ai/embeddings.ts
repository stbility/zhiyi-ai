/**
 * Embedding 服务(OpenAI 兼容 /embeddings 端点)。
 *
 * 未配置时返回 null —— 调用方如实降级(召回回到「最近优先」,
 * 沉淀时不写向量),绝不假装向量可用。失败也是观察结果:
 * 记日志、返回 null,不阻断沉淀与召回主流程。
 *
 * 注意:本模块不带 server-only 守卫 —— 纯函数 + fetch,测试可直接导入;
 * 调用方(memories.ts / agent-turn)都在服务端,env 不会进客户端产物。
 */

export interface EmbeddingsConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export function getEmbeddingsConfig(): EmbeddingsConfig | null {
  const apiUrl = process.env["EMBEDDINGS_API_URL"]?.trim();
  const apiKey = process.env["EMBEDDINGS_API_KEY"]?.trim();
  if (!apiUrl || !apiKey) return null;
  return {
    apiUrl,
    apiKey,
    model: process.env["EMBEDDINGS_MODEL"]?.trim() || "text-embedding-3-small",
  };
}

/** 批量生成向量;失败或未配置返回 null(降级信号) */
export async function embedTexts(
  texts: readonly string[],
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
      body: JSON.stringify({ model: config.model, input: texts }),
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

/** 单条文本向量(沉淀时用) */
export async function embedText(text: string): Promise<number[] | null> {
  const vectors = await embedTexts([text]);
  return vectors?.[0] ?? null;
}
