import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 设计系统 token 保护测试。
 *
 * 存在意义:tokens/*.css 是从设计系统逐字节复制过来的唯一真值源。任何人(包括
 * 后续的 AI 改动)若「顺手」调了一个色值或圆角,这里必须失败。设计系统的继承
 * 靠断言保证,不靠承诺。
 *
 * 参考值直接取自设计系统源文件,不是重新推导的。
 */

const TOKENS_DIR = resolve(__dirname, "../../src/styles/tokens");

function readTokens(file: string): Map<string, string> {
  const css = readFileSync(resolve(TOKENS_DIR, `${file}.css`), "utf8");
  const map = new Map<string, string>();
  // 去掉块注释,避免注释里的伪声明被解析
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
    const name = match[1];
    const value = match[2];
    if (name && value) map.set(name, value.trim());
  }
  return map;
}

describe("设计系统 token 未被篡改", () => {
  it("色板与设计系统一致", () => {
    const colors = readTokens("colors");
    // 四级表面阶梯 —— 近黑偏蓝画布,绝不使用纯黑
    expect(colors.get("--bg-canvas")).toBe("#07080B");
    expect(colors.get("--surface-1")).toBe("#0D0F14");
    expect(colors.get("--surface-2")).toBe("#12151C");
    expect(colors.get("--surface-3")).toBe("#171B24");
    expect(colors.get("--surface-4")).toBe("#1D222D");
    // 单一品牌色,不得新增第二个高饱和强调色
    expect(colors.get("--brand-primary")).toBe("#6977E8");
    expect(colors.get("--brand-hover")).toBe("#8490F5");
    expect(colors.get("--brand-active")).toBe("#5967D4");
    // 描边
    expect(colors.get("--border-default")).toBe("#242832");
    expect(colors.get("--border-strong")).toBe("#323846");
    // 语义色
    expect(colors.get("--success")).toBe("#32A866");
    expect(colors.get("--warning")).toBe("#D7A23B");
    expect(colors.get("--error")).toBe("#D95C5C");
    expect(colors.get("--info")).toBe("#5C8FE8");
  });

  it("中文字体栈符合 DESIGN.md:PingFang SC 仅作系统字体调用", () => {
    const type = readTokens("typography");
    const zh = type.get("--font-zh");
    expect(zh).toBeDefined();
    expect(zh).toContain('"PingFang SC"');
    expect(zh).toContain('"Noto Sans SC"');
    expect(zh).toContain('"Microsoft YaHei"');
    // 必须有最终兜底,任一 webfont 不可用都不能导致无字体
    expect(zh).toContain("system-ui");
  });

  it("字体不得被自托管打包 —— PingFang SC 禁止随包分发", () => {
    const fonts = readFileSync(resolve(TOKENS_DIR, "fonts.css"), "utf8");
    expect(fonts).not.toMatch(/@font-face/i);
    expect(fonts.toLowerCase()).not.toContain("pingfang.");
  });

  it("圆角刻度与设计系统一致", () => {
    const radius = readTokens("radius");
    expect(radius.get("--radius-tag")).toBe("4px");
    expect(radius.get("--radius-control")).toBe("8px");
    expect(radius.get("--radius-card")).toBe("12px");
    expect(radius.get("--radius-panel")).toBe("16px");
    expect(radius.get("--radius-full")).toBe("9999px");
  });

  it("动效时长与缓动曲线未被放宽", () => {
    const motion = readTokens("motion");
    expect(motion.get("--ease-standard")).toBe("cubic-bezier(0.4,0,0.2,1)");
    expect(motion.get("--duration-hover")).toBe("120ms");
    expect(motion.get("--duration-transition")).toBe("160ms");
    expect(motion.get("--duration-panel")).toBe("200ms");
    expect(motion.get("--duration-enter")).toBe("220ms");
  });

  it("阴影仅覆盖四个浮层场景,未被滥用到普通卡片", () => {
    const shadows = readTokens("shadows");
    const names = [...shadows.keys()].filter((k) => k.startsWith("--shadow-"));
    expect(new Set(names)).toEqual(
      new Set([
        "--shadow-dropdown",
        "--shadow-modal",
        "--shadow-flyout",
        "--shadow-sheet",
      ]),
    );
  });

  it("固定布局宽度与设计系统一致", () => {
    const spacing = readTokens("spacing");
    expect(spacing.get("--sidebar-width")).toBe("248px");
    expect(spacing.get("--assistant-width")).toBe("360px");
  });
});
