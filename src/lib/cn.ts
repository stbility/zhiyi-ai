import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge 默认只认识 Tailwind 内置的 theme scale。我们的 theme 全部来自
 * 设计系统 token(见 src/app/globals.css),对它而言是未知名称 —— 它会把
 * `text-button` 这类字号猜成文字颜色,进而被后面的 `text-on-brand` 覆盖掉,
 * 表现为字号静默失效(不报错、不报警)。
 *
 * 因此必须把设计系统的 scale 显式登记进来。新增 token 时同步更新这里,
 * 否则该 token 参与 className 合并时会出现难以定位的覆盖问题。
 * 登记完整性由 tests/design-system/cn-merge.test.ts 守护。
 */

const DS_COLORS = [
  "canvas",
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-4",
  "border-default",
  "border-strong",
  "border-focus",
  "divider",
  "brand",
  "brand-hover",
  "brand-active",
  "brand-tint",
  "brand-ring",
  "fg",
  "fg-secondary",
  "fg-tertiary",
  "fg-disabled",
  "on-brand",
  "success",
  "success-tint",
  "warning",
  "warning-tint",
  "error",
  "error-tint",
  "error-hover",
  "error-active",
  "info",
  "info-tint",
  "paper-bg",
  "paper-surface",
  "paper-border",
  "paper-fg",
  "paper-fg-secondary",
] as const;

const DS_TEXT_SIZES = [
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "caption",
  "label",
  "button",
] as const;

const DS_RADII = [
  "tag",
  "control",
  "card",
  "panel",
  "bubble",
  "modal",
] as const;

const DS_SHADOWS = ["dropdown", "modal", "flyout", "sheet"] as const;

const DS_FONTS = ["zh", "latin", "mono", "sans"] as const;

const DS_SPACING = ["sidebar", "assistant"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [...DS_COLORS],
      text: [...DS_TEXT_SIZES],
      radius: [...DS_RADII],
      shadow: [...DS_SHADOWS],
      font: [...DS_FONTS],
      spacing: [...DS_SPACING],
      ease: ["standard"],
      container: ["reading"],
    },
  },
});

/**
 * 合并 className,后写的 Tailwind 工具类覆盖先写的同类工具类。
 * 使组件能通过 className 定制,而不必开放 style 逃生口。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 供测试断言登记完整性 */
export const DS_SCALES = {
  colors: DS_COLORS,
  textSizes: DS_TEXT_SIZES,
  radii: DS_RADII,
  shadows: DS_SHADOWS,
  fonts: DS_FONTS,
  spacing: DS_SPACING,
} as const;
