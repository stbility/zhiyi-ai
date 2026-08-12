import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 一体式输入框契约(2026-08-12 对齐 Hermes 官方设计)。
 *
 * 用户诉求:发送按钮设计在输入框内(右下角),不是输入框下方单独一排。
 * 守的契约:
 *   1. form 容器带边框/圆角/背景 —— 一个整体盒子
 *   2. textarea 透明无框,融入容器
 *   3. 底部工具条(附件/联网/模型/发送)在容器内,顶部细分隔线
 *   4. 发送按钮仍在工具条内(容器右下角)
 */

const SRC = readFileSync(
  resolve(__dirname, "../../src/components/app/ChatPanel.tsx"),
  "utf8",
);

describe("一体式输入框", () => {
  it("form 容器带边框/圆角/背景(一个整体盒子)", () => {
    expect(SRC).toMatch(
      /className="border-border-default bg-surface-2 rounded-control border"/,
    );
  });

  it("textarea 透明无框,融入容器", () => {
    expect(SRC).toMatch(/bg-transparent/);
    expect(SRC).not.toMatch(
      /<textarea[\s\S]{0,200}?className="bg-surface-2 border-border-default/,
    );
  });

  it("底部工具条在容器内,顶部细分隔线", () => {
    expect(SRC).toMatch(
      /className="border-border-default flex flex-wrap items-center gap-1\.5 border-t px-3 py-2"/,
    );
  });

  it("发送按钮仍在工具条内(容器右下角),空输入隐藏、打字出现", () => {
    expect(SRC).toMatch(/draft\.trim\(\) !== "" \|\| streaming/);
    expect(SRC).toMatch(/aria-label="发送"/);
    // 发送按钮在 Select 之后(工具条右侧)
    const selectIdx = SRC.indexOf('aria-label="对话输入"');
    const sendIdx = SRC.indexOf('aria-label="发送"');
    expect(sendIdx).toBeGreaterThan(selectIdx);
  });

  it("会话删除按钮手机端可见(无 hover 设备)", () => {
    // 默认(含手机)可见,桌面端才 hover 显示
    expect(SRC).toMatch(/opacity-100 transition-opacity/);
    expect(SRC).toMatch(/md:opacity-0 md:group-hover:opacity-100/);
    // 不再有裸 opacity-0(全端隐藏)
    expect(SRC).not.toMatch(
      /className="text-fg-tertiary hover:text-error rounded-control cursor-pointer p-1 opacity-0/,
    );
  });
});
