import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { APP_NAV, AppChrome } from "@/components/app/AppChrome";

/**
 * 导航必须是真正的链接。
 *
 * 真实故障:用户报「AI助手、工作区、集成、模型服务按钮全部需多次点击才生效」。
 * 那四项正是左侧导航里已交付的四个。根因是它们被写成
 * <button onClick={() => router.push(href)}>:
 *
 *   1. 水合完成前完全是死的 —— 事件还没挂上,点了没有任何反应
 *   2. 不会预取。这些页面是 force-dynamic,点下去要等服务端跑完查询,
 *      屏幕一两秒毫无变化,用户当然会再点
 *   3. 中键 / Cmd+点击 / 右键「在新标签页打开」全部失效
 *
 * <a href> 三条全部天然满足,而且零 JavaScript 也能用。
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/today",
}));

// jsdom 没有 matchMedia,而主题切换会读它判断系统偏好
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function setup() {
  return render(
    <AppChrome displayName="测试用户" organizationName="测试组织">
      <div>内容</div>
    </AppChrome>,
  );
}

describe("应用导航", () => {
  it("已交付的导航项都是带 href 的链接,不是 button", () => {
    const { container } = setup();
    const delivered = APP_NAV.filter((n) => n.available);
    expect(delivered.length).toBeGreaterThan(0);

    for (const item of delivered) {
      const links = container.querySelectorAll(`a[href="${item.href}"]`);
      expect(links.length, `${item.label} 应当是 <a href>`).toBeGreaterThan(0);
    }
  });

  it("未交付的导航项不可点击,并如实标注", () => {
    setup();
    const pending = APP_NAV.filter((n) => !n.available);
    for (const item of pending) {
      // 让用户点进 404,和放一个空按钮是同一类问题
      const el = screen.getAllByText(item.label)[0]!;
      expect(el.closest("a")).toBeNull();
    }
    // 全部交付时「建设中」不应出现;有未交付项时数量一一对应。
    // queryAllByText 在零匹配时返回 [] 而不抛错,兼容「全部解锁」状态。
    expect(screen.queryAllByText("建设中").length).toBe(pending.length);
  });

  it("当前页要标出来,读屏才知道自己在哪", () => {
    const { container } = setup();
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]?.getAttribute("href")).toBe("/today");
  });
});
