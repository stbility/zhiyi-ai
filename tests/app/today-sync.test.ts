import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 今日页同步契约(2026-08-12 修复)。
 *
 * 用户报「今日页面与系统不同步」—— 页面曾写「工作流、知识库与长期记忆的
 * 数据层尚未建立」,而 0036 工作流/0038 知识库/0028+0040 记忆均已上线。
 * 守的契约:
 *   1. 不再出现过时的「数据层尚未建立」文案
 *   2. 已交付模块有真实链接(工作流/知识库/记忆/报表)
 *   3. 真正未交付项如实列出(后台 Worker/监控/备份回滚)
 */

const SRC = readFileSync(
  resolve(__dirname, "../../src/app/(app)/today/page.tsx"),
  "utf8",
);

describe("今日页同步", () => {
  it("不再有过时的「数据层尚未建立」文案", () => {
    expect(SRC).not.toMatch(/数据层尚未建立/);
    expect(SRC).not.toMatch(/AI 摘要、工作流、知识库与长期记忆/);
  });

  it("已交付模块有真实链接(工作流/知识库/记忆/报表)", () => {
    expect(SRC).toMatch(/href="\/workflow"/);
    expect(SRC).toMatch(/href="\/knowledge"/);
    expect(SRC).toMatch(/href="\/memory"/);
    expect(SRC).toMatch(/href="\/reports"/);
  });

  it("真正未交付项如实列出", () => {
    expect(SRC).toMatch(/尚未交付:后台 Worker/);
    expect(SRC).toMatch(/监控与备份回滚/);
  });

  it("标题改为「快捷入口」(不再是「尚未交付的模块」)", () => {
    expect(SRC).toMatch(/快捷入口/);
    expect(SRC).not.toMatch(/尚未交付的模块/);
  });
});
