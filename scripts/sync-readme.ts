/**
 * README 阶段表生成器(2026-08-10 开发治理 P1,治「README 与阶段不同步」)。
 *
 * 从 src/lib/phase.ts(单一真值源)对齐 README 阶段表里**机器可校验的部分**:
 *   1. 每行状态 emoji 与 phase.state 一致(done→✅ / partial→🟡 / todo→⬜)
 *   2. 「上次同步:日期,main@SHA」行自动更新(保留手写的富文本描述,不重写整表)
 *   3. 缺行的阶段报错退出(提示手动补行,不替你编内容)
 *
 * 用法:pnpm sync:readme   (tsx 运行,仓库根执行)
 * 守卫:tests/app/readme-phase-sync.test.ts 会在 CI 拦下「生成后仍漂移」。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CURRENT_PHASE, PHASE_STATUS } from "../src/lib/phase";

const README_PATH = resolve(import.meta.dirname, "../README.md");
const EMOJI: Record<"done" | "partial" | "todo", string> = { done: "✅", partial: "🟡", todo: "⬜" };

function main(): void {
  const readme = readFileSync(README_PATH, "utf8");
  const lines = readme.split("\n");
  let changed = 0;

  for (const phase of PHASE_STATUS) {
    const idEscaped = phase.id.replace(".", "\\.");
    const idx = lines.findIndex((l) => new RegExp(`^\\| ${idEscaped} \\|`).test(l));
    if (idx < 0) {
      console.error(`❌ 阶段 ${phase.id}(${phase.label}) 在 README 阶段表缺行 —— 手动补一行再跑:`);
      console.error(`   | ${phase.id} | ${phase.label} | ${EMOJI[phase.state]} 状态描述 |`);
      process.exit(1);
    }
    const target = EMOJI[phase.state];
    const line = lines[idx]!;
    const fixed = line.replace(/[✅🟡⬜]/u, target);
    if (fixed !== line) {
      lines[idx] = fixed;
      changed += 1;
    }
  }

  // 上次同步行:日期 + main SHA + 生成器说明
  // ⚠️ 必须整块替换:连续「> 」开头的行都是同步块(旧格式第二行是
  // 「> 线上以」,新格式是「> 改动」)——只删第一行会把第二行复制一份,
  // 生成器从此不幂等(2026-08-10 实锤:重复运行后同步块变 3 行)。
  const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  const today = new Date().toISOString().slice(0, 10);
  const syncBlock = [
    `> 上次同步:${today},main@${sha}。本表由 scripts/sync-readme.ts 从 src/lib/phase.ts 生成;`,
    "> 改动 `src/lib/phase.ts` 后跑 `pnpm sync:readme`。线上以 https://zhiyi-agent.com/status 为准。",
  ];
  const syncStart = lines.findIndex((l) => l.startsWith("> 上次同步:"));
  if (syncStart >= 0) {
    let syncEnd = syncStart + 1;
    while (syncEnd < lines.length && lines[syncEnd]?.startsWith("> ")) {
      syncEnd += 1;
    }
    lines.splice(syncStart, syncEnd - syncStart, ...syncBlock);
    changed += 1;
  }

  writeFileSync(README_PATH, lines.join("\n"));
  console.log(`✅ README 阶段表已同步(改动 ${changed} 处):${today},main@${sha}`);
  if (!readme.includes(`Phase ${CURRENT_PHASE.id}`)) {
    console.warn(`⚠️ README 未含当前 Phase ${CURRENT_PHASE.id} —— 如缺请补正文声明。`);
  }
}

main();
