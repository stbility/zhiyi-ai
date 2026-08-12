import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 侧边导航分组契约(2026-08-12)。
 *
 * 用户诉求:导航按钮太多,需要分类;且底部退出区不能被挤出视口。
 * 守的契约:
 *   1. 每个导航项都有分组(workspace/knowledge/admin)
 *   2. 导航区可独立滚动(min-h-0 + overflow-y-auto),底部用户区固定
 *   3. 分组渲染:组标题 + 组内项
 */

const CHROME = readFileSync(
  resolve(__dirname, "../../src/components/app/AppChrome.tsx"),
  "utf8",
);

describe("侧边导航分组", () => {
  it("每个导航项都有 group 字段且取值合法", () => {
    const groups = ["workspace", "knowledge", "admin"];
    // 统计 group 出现次数:14 个导航项都应该有 group 字段
    const navItems = CHROME.match(/group: "(workspace|knowledge|admin)"/g) ?? [];
    expect(navItems.length).toBeGreaterThanOrEqual(14);
  });

  it("导航区独立滚动,底部退出区固定(不挤出视口)", () => {
    // nav 容器:min-h-0 + flex-1 + overflow-y-auto
    expect(CHROME).toMatch(/min-h-0 flex-1 flex-col gap-0\.5 overflow-y-auto/);
    // 外层容器 h-dvh + overflow-hidden(滚动发生在导航区内部)
    expect(CHROME).toMatch(/h-dvh w-full overflow-hidden/);
    // 底部用户区仍在侧栏底部(border-t 分隔)
    expect(CHROME).toMatch(/border-divider flex flex-col gap-2 border-t p-4/);
  });

  it("分组标题渲染(NAV_GROUPS 有 3 组)", () => {
    expect(CHROME).toMatch(/NAV_GROUPS/);
    expect(CHROME).toMatch(/工作区/);
    expect(CHROME).toMatch(/知识与数据/);
    expect(CHROME).toMatch(/管理与设置/);
  });

  it("导航项按分组过滤渲染,不重复", () => {
    expect(CHROME).toMatch(/APP_NAV\.filter\(\(item\) => item\.group === group\.id\)/);
  });
});
