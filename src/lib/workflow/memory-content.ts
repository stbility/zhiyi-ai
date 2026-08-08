/**
 * 工作流产物 → 记忆正文的纯函数。
 *
 * 单独放一个不带 server-only 的模块,让测试可以直接 import
 * (memories.ts 带 server-only,在 CI 冷启动下会抛错 —— 见
 * vitest.config.ts 的 server.deps.inline 注释与测试经验)。
 */
export const WORKFLOW_MEMORY_MAX_CHARS = 2000;

/** 把工作流步骤输出截成可入库的记忆正文 */
export function buildWorkflowMemoryContent(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= WORKFLOW_MEMORY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, WORKFLOW_MEMORY_MAX_CHARS)}…(截断)`;
}
