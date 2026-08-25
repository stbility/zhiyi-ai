/**
 * 默认模型选择。
 *
 * ChatPanel 的默认选中过去直接取 models[0](字母序),导致新会话默认落在
 * google/gemma-4-31b-it —— 该模型挂 NVIDIA NIM 实测 270s 无首 token
 * (8-23T18:43 / 8-24T09:43 两次 failed 实证)。这里把「默认值」与
 * 「字母序首项」解耦:只排除实证不可用的模型,不限制用户手动选择任何模型。
 */

/** 实证不可用模型(270s 无首 token / 已 EOL)。新增不可用模型时在此追加。 */
export const UNSTABLE_MODEL_IDS: ReadonlySet<string> = new Set([
  "google/gemma-4-31b-it",
]);

export interface DefaultModelOption {
  readonly modelId: string;
  readonly value: string;
}

/**
 * 从模型列表中选出默认选中项:
 * - 空列表 → ""
 * - 优先取首个不在 UNSTABLE_MODEL_IDS 中的模型(保持原排序语义)
 * - 全部不稳定 → 回退 models[0](用户仍可手动选择)
 */
export function pickDefaultModel(
  models: readonly DefaultModelOption[],
): string {
  if (models.length === 0) return "";
  const healthy = models.find((m) => !UNSTABLE_MODEL_IDS.has(m.modelId));
  // noUncheckedIndexedAccess:models[0] 类型为 T|undefined,用 ?. 链式兜底
  return healthy?.value ?? models[0]?.value ?? "";
}
