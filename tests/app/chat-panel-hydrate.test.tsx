import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatPanel,
  type ConversationSummary,
  type InitialTurn,
  type ModelOption,
} from "@/components/app/ChatPanel";

/**
 * 助手页水合测试。
 *
 * 真实故障:助手页白屏,但服务端 /assistant 返回 200、日志零错误,
 * 组件在 CSR 下也渲染正常 —— 那么问题只可能出在**水合**这一步。
 * React 19 水合失败会把整棵树卸载重来,失败两次就是一片空白,
 * 而且服务端什么都看不到。
 *
 * CSR 渲染测试盖不住这条路径,必须真的「服务端出串 → 客户端水合」跑一遍。
 */

// ChatPanel 引入了对话删除的 server action,后者会连带引入 server-only。
// 生产环境由 Next.js 特殊处理,测试环境需要显式打桩。
vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const MODELS: ModelOption[] = [
  {
    providerId: "b40a71d7-97e3-4bae-ac21-72dae67b14a7",
    providerName: "integrate",
    modelId: "z-ai/glm-5.2",
    value: "b40a71d7-97e3-4bae-ac21-72dae67b14a7::z-ai/glm-5.2",
  },
];

const CONVERSATIONS: ConversationSummary[] = [
  { id: "c1", title: "第一次对话", createdAt: "2026-07-29T01:00:00Z" },
];

const TURNS: InitialTurn[] = [
  {
    id: "m1",
    role: "user",
    content: "你好",
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    error: null,
  },
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("助手页水合", () => {
  it("服务端输出能被客户端无错水合 —— 水合失败即白屏", async () => {
    const element = (
      <ChatPanel
        models={MODELS}
        conversations={CONVERSATIONS}
        activeConversationId="c1"
        initialTurns={TURNS}
        initialFileCount={0}
      />
    );

    const html = renderToString(element);
    expect(html).toContain("第一次对话");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    // React 把水合不一致报成 error;onRecoverableError 则收到「已恢复但发生过」的错误。
    // 两者都要抓 —— 后者正是「页面闪一下变空白」的来源。
    const errors: string[] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });

    const root = await act(async () =>
      hydrateRoot(container, element, {
        onRecoverableError: (e) => errors.push(String(e)),
      }),
    );

    expect(
      errors.filter((e) => /hydrat|mismatch|did not match/i.test(e)),
      `水合报错:\n${errors.join("\n")}`,
    ).toHaveLength(0);

    // 水合后内容仍在,没有被卸载成空白
    expect(container.textContent).toContain("你好");
    // 控件是纯图标的,文案只存在于 aria-label —— 断言可访问名称,
    // 顺带守住「无文字不等于无标签」这条底线
    expect(
      container.querySelector('[aria-label="添加文件夹"]'),
    ).toBeTruthy();
    expect(container.querySelector('[aria-label="智能体"]')).toBeTruthy();

    consoleError.mockRestore();
    await act(async () => root.unmount());
  });
});
