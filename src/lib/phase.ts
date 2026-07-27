/**
 * 当前交付阶段。
 *
 * 单点维护,避免页面文案与实际进度脱节。产品对外宣称的进度必须与真实进度一致。
 */
export const CURRENT_PHASE = {
  id: "1",
  label: "Phase 1(认证、数据库与权限隔离)",
  /**
   * 产品能力(需求三至六章)是否已经开始交付。
   * 认证与组织已可用,但工作流、知识库、长期记忆、模型网关均未交付,
   * 因此这里仍为 false —— 不能因为「有东西能用了」就对外宣称产品已成型。
   */
  productCapabilitiesShipped: false,
} as const;
