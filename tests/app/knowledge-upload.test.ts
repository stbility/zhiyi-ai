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

  it("预览全文展示,不再 slice 截断(修复「解析不完整」误报)", () => {
    expect(SRC).not.toMatch(/contentText\.slice\(/);
    expect(SRC).toMatch(/\{selected\.contentText\}/);
    // 超长时滚动,不溢出页面
    expect(SRC).toMatch(/max-h-\[70vh\] overflow-y-auto/);
  });

  it("文件行窄屏不叠加(修复「PDF、md 文字叠加在一起」)", () => {
    const rowSrc = readFileSync(
      resolve(__dirname, "../../src/components/knowledge/KnowledgeFileRow.tsx"),
      "utf8",
    );
    // 窄屏 3 列(名称/类型/大小),宽屏才恢复 5 列
    expect(rowSrc).toMatch(/grid-cols-\[1fr_auto_auto\]/);
    expect(rowSrc).toMatch(/md:grid-cols-\[1fr_90px_110px_130px_110px\]/);
    // 不再有裸 5 列写法(不带 md: 前缀的)
    expect(rowSrc).not.toMatch(/(?<!md:)grid-cols-\[1fr_90px_110px_130px_110px\]/);
  });

  it("检索框用原生 Input 组件(设计统一)", () => {
    expect(SRC).toMatch(/<Input/);
    expect(SRC).toMatch(/hideLabel/);
    // 不再有裸检索 input(带手写边框类)
    expect(SRC).not.toMatch(
      /placeholder="检索文件名称或正文…"\s+className="border-border-default bg-surface-2/,
    );
  });

  it("上传 label 用系统惯例 text-label", () => {
    expect(SRC).toMatch(/<label className="text-fg-secondary text-label">/);
  });
});
