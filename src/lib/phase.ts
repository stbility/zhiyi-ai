/**
 * 当前交付阶段。
 *
 * 单点维护,避免页面文案与实际进度脱节 —— 上一版状态页就因为写死了「Phase 0.5」
 * 而在 0.6 完成后仍显示旧阶段。产品对外宣称的进度必须与真实进度一致。
 */
export const CURRENT_PHASE = {
  id: "0.6",
  label: "Phase 0.6(设计系统组件移植)",
  /** 产品能力(需求三至六章)是否已经开始交付 */
  productCapabilitiesShipped: false,
} as const;
