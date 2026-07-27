import { describe, expect, it } from "vitest";

import { cn, DS_SCALES } from "@/lib/cn";

/**
 * cn() 合并行为测试。
 *
 * 背景:tailwind-merge 默认只认识 Tailwind 内置 theme scale。若设计系统的 token
 * 名称没有登记进去,它会误判分组 —— 例如把字号 `text-button` 当成文字颜色,
 * 被后面的 `text-on-brand` 覆盖掉,表现为字号静默失效。这类问题不报错、不告警,
 * 只能靠断言拦住。此前 Button 的 md/lg 尺寸就因此变成了 15px(应为 14px)。
 */

describe("cn:设计系统 scale 已正确登记", () => {
  it("字号与文字颜色属于不同分组,不得互相覆盖", () => {
    const result = cn("text-button", "text-on-brand");
    expect(result).toContain("text-button");
    expect(result).toContain("text-on-brand");
  });

  it("每个设计系统字号都不会被文字颜色挤掉", () => {
    for (const size of DS_SCALES.textSizes) {
      const result = cn(`text-${size}`, "text-fg");
      expect(result, `text-${size} 被 text-fg 覆盖`).toContain(`text-${size}`);
      expect(result).toContain("text-fg");
    }
  });

  it("同类工具类仍然正常去重 —— 后写的胜出", () => {
    expect(cn("bg-surface-2", "bg-surface-3")).toBe("bg-surface-3");
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("rounded-card", "rounded-panel")).toBe("rounded-panel");
    expect(cn("text-fg", "text-fg-tertiary")).toBe("text-fg-tertiary");
  });

  it("圆角、阴影、字体族、间距各自独立分组", () => {
    const result = cn(
      "rounded-card",
      "shadow-modal",
      "font-zh",
      "w-sidebar",
      "ease-standard",
    );
    for (const cls of [
      "rounded-card",
      "shadow-modal",
      "font-zh",
      "w-sidebar",
      "ease-standard",
    ]) {
      expect(result).toContain(cls);
    }
  });

  it("背景色与文字色不互相覆盖", () => {
    const result = cn("bg-brand", "text-on-brand", "border-brand");
    expect(result).toContain("bg-brand");
    expect(result).toContain("text-on-brand");
    expect(result).toContain("border-brand");
  });

  it("className 覆盖能力可用 —— 调用方可定制", () => {
    expect(cn("bg-surface-2 p-5", "bg-surface-4")).toBe("p-5 bg-surface-4");
  });

  it("条件类与假值被正确忽略", () => {
    expect(cn("bg-brand", false, undefined, null, "")).toBe("bg-brand");
  });
});

describe("cn:登记表覆盖 globals.css 中的全部 token", () => {
  it("颜色登记表非空且含关键语义色", () => {
    for (const key of ["brand", "fg", "on-brand", "surface-2", "error-hover"]) {
      expect(DS_SCALES.colors).toContain(key);
    }
  });

  it("字号登记表与设计系统排版刻度一致", () => {
    expect([...DS_SCALES.textSizes]).toEqual([
      "display",
      "h1",
      "h2",
      "h3",
      "body-lg",
      "body",
      "caption",
      "label",
      "button",
    ]);
  });
});
