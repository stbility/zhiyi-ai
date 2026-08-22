import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * README 阶段表 ↔ phase.ts 全表一致性守卫(2026-08-10 加强版)。
 *
 * 根因(实证):旧守卫只断言 README「含 Phase 4」+「不含一句过时文案」,
 * 9 行阶段表完全不在覆盖内 —— Phase 6(Stripe 订阅)已上线却写「未开始」,
 * 漂移无声发生。本测试逐行校验:
 *   1. PHASE_STATUS 里的每个阶段,README 阶段表都有一行对应
 *   2. 行的状态 emoji 必须与 phase.ts 的 state 一致(done→✅ / partial→🟡 / todo→⬜)
 *   3. 状态语义不得自相矛盾(done 行不得出现「未做/未开始/未创建/未交付」)
 *
 * phase.ts 是单一真值源;README 是手工副本,本测试保证副本不漂移。
 */
const README = readFileSync(resolve(__dirname, "../../README.md"), "utf8");

/** 阶段表区域:从表头行到「上次同步」之前 */
function stageTable(): string {
  const start = README.indexOf("| 阶段 | 内容 | 状态 |");
  const end = README.indexOf("> 上次同步");
  if (start < 0 || end < 0) return "";
  return README.slice(start, end);
}

const EMOJI_FOR_STATE = { done: "✅", partial: "🟡", todo: "⬜" } as const;

const NEGATIVE_MARKERS = ["未做", "未开始", "未创建", "未交付", "尚未创建"];

describe("进度自述一致性(README ↔ phase.ts 全表)", () => {
  it("README 阶段表存在", () => {
    expect(stageTable()).toContain("| 阶段 | 内容 | 状态 |");
  });

  it("每个阶段的表行存在,且状态 emoji 与 phase.ts 一致", async () => {
    const { PHASE_STATUS } = await import("@/lib/phase");
    const table = stageTable();
    for (const phase of PHASE_STATUS) {
      const rowPattern = new RegExp(
        `\\| ${phase.id.replace(".", "\\.")} \\|[^\\n]*\\| [✅🟡⬜] [^\\n]*\\|`,
        "u",
      );
      const row = table.match(rowPattern);
      expect(row, `阶段 ${phase.id}(${phase.label}) 在 README 阶段表缺行`).not.toBeNull();
      expect(row![0], `阶段 ${phase.id} 状态 emoji 与 phase.ts 不一致`).toContain(
        EMOJI_FOR_STATE[phase.state],
      );
    }
  });

  it("done 状态的行不得自相矛盾地写「未交付」", async () => {
    const { PHASE_STATUS } = await import("@/lib/phase");
    const table = stageTable();
    for (const phase of PHASE_STATUS.filter((p) => p.state === "done")) {
      const row = table.match(
        new RegExp(`\\| ${phase.id.replace(".", "\\.")} \\|[^\\n]*\\| ✅ [^\\n]*\\|`, "u"),
      );
      if (!row) continue; // 上一测试已保证存在
      for (const marker of NEGATIVE_MARKERS) {
        expect(
          row[0],
          `阶段 ${phase.id} 标记为 ✅ 已完成,却写了「${marker}」`,
        ).not.toContain(marker);
      }
    }
  });

  it("README 声明当前 Phase(旧守卫保留)", async () => {
    const { CURRENT_PHASE } = await import("@/lib/phase");
    expect(README).toContain(`Phase ${CURRENT_PHASE.id}`);
    expect(README).not.toContain("模型网关均未交付");
  });

  it("同步块恰好一组(生成器幂等 —— 2026-08-10 实锤:重复运行会复制第二行)", () => {
    // 注意:第二行是「> 改动 ... 线上以 ...」,「> 线上以」前缀永不匹配,
    // 断言用中间的「线上以 https://zhiyi-agent.com/status 为准」计数。
    const matches = README.match(/线上以 https:\/\/zhiyi-agent\.com\/status 为准。/g);
    expect(matches?.length ?? 0).toBe(1);
    expect(README).toContain("本表由 scripts/sync-readme.ts 从 src/lib/phase.ts 生成");
  });
});
