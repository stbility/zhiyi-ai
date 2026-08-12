import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 知识库上传按钮契约(2026-08-12 修复)。
 *
 * 用户报「上传文件按钮标签无法上传文件」—— 根因是裸原生
 * <input type="file"> 直接暴露,暗色主题下按钮不可见/难点击。
 * 修复:input 隐藏(sr-only) + 设计系统 Button 触发 + 显示已选文件名。
 *
 * 守的契约:
 *   1. 原生 input 隐藏,不再直接暴露
 *   2. 由设计系统 Button 触发(点击 → input.click())
 *   3. 选择后显示文件名
 *   4. accept 仍限定 pdf/docx/md/txt
 */

const SRC = readFileSync(
  resolve(__dirname, "../../src/components/app/KnowledgeManager.tsx"),
  "utf8",
);

describe("知识库上传按钮", () => {
  it("原生 file input 隐藏(sr-only),不直接暴露", () => {
    expect(SRC).toMatch(/type="file"/);
    expect(SRC).toMatch(/className="sr-only"/);
  });

  it("由设计系统 Button 触发(input.click())", () => {
    expect(SRC).toMatch(/fileInputRef\.current\?\.click\(\)/);
    expect(SRC).toMatch(/选择文件/);
  });

  it("选择后显示文件名(pickedName)", () => {
    expect(SRC).toMatch(/setPickedName/);
    expect(SRC).toMatch(/pickedName &&/);
    expect(SRC).toMatch(/truncate/);
  });

  it("accept 限定 pdf/docx/md/txt", () => {
    expect(SRC).toMatch(/accept="\.pdf,\.docx,\.md,\.markdown,\.txt"/);
  });
});
