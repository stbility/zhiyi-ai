import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ChatPanel,
  type ConversationSummary,
  type InitialTurn,
  type ModelOption,
} from "@/components/app/ChatPanel";

/**
 * 助手页渲染测试。
 *
 * 真实故障:改版后助手页白屏无内容,而服务端日志干净(零 4xx/5xx)——
 * 说明是客户端渲染阶段炸了。这类错构建期不报,只有真渲染一次才暴露。
 *
 * 所以这里不测样式,只测一件事:**给定真实形状的数据,组件能不能渲染出来**。
 * 白屏是最严重的故障 —— 用户什么都做不了,也看不到任何线索。
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
  { id: "c2", title: "第二次对话", createdAt: "2026-07-29T02:00:00Z" },
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
  {
    id: "m2",
    role: "assistant",
    content: "你好,有什么可以帮你的?",
    inputTokens: 12,
    outputTokens: 34,
    latencyMs: 850,
    error: null,
  },
];

describe("助手页渲染", () => {
  it("有模型、有历史时能正常渲染,不白屏", () => {
    render(
      <ChatPanel
      channel="chat"
        models={MODELS}
        conversations={CONVERSATIONS}
        activeConversationId="c1"
        initialTurns={TURNS}
      />,
    );

    // 历史消息要真的显示出来 —— 这正是「关掉页面不丢」的意义
    expect(screen.getByText("你好")).toBeTruthy();
    expect(screen.getByText("你好,有什么可以帮你的?")).toBeTruthy();
    // 左侧对话列表
    expect(screen.getByText("第一次对话")).toBeTruthy();
    expect(screen.getByText("新对话")).toBeTruthy();
    // 输入框下方的控件。
    //
    // 「联网」是**模式**,用设计系统的 Tag(active 时填品牌色、
    // 可点击时渲染成真 button)。它有可见文字,所以无障碍名就是文字本身 ——
    // 比此前那版纯图标 + aria-label 更好:看得见的标签和读屏念出来的
    // 是同一个东西,不会对不上。
    //
    // 「添加文件夹」是一次性动作不是模式,仍用 IconButton + aria-label。
    expect(screen.getByLabelText("添加文件夹")).toBeTruthy();
    expect(screen.getByRole("button", { name: "联网" })).toBeTruthy();

    // 发送按钮**空输入时不出现** —— 照 Claude 的 composer:
    // 「The send button appears only once there is something to ship」。
    // 用出现与否本身当作「这条可以发了」的信号。
    expect(screen.queryByLabelText("发送")).toBeNull();

    // 「智能体」曾经是这里的第三个 Tag,状态存在 localStorage 里。
    // 删掉了 —— 它现在是**另一条通道**(/agent),不是这个输入框上的开关。
    //
    // 那个开关有一个用户实测过的坏处:状态看不见。它默认持久化,
    // 于是用户在 AI 助手页打的每一句话都在悄悄走智能体循环,
    // 而界面上没有任何东西告诉他。
    expect(screen.queryByRole("button", { name: "智能体" })).toBeNull();
  });

  it("打了字,发送按钮就出现 —— 这是上一条的正向对照", () => {
    // 少了这一条,「空输入时没有发送按钮」可能因为按钮**根本没渲染出来**
    // 而碰巧成立 —— 那是个白屏 bug,却会被当成正确行为。
    render(
      <ChatPanel
      channel="chat"
        models={MODELS}
        conversations={CONVERSATIONS}
        activeConversationId="c1"
        initialTurns={[]}
      />,
    );

    expect(screen.queryByLabelText("发送")).toBeNull();
    fireEvent.change(screen.getByLabelText("对话输入"), {
      target: { value: "你好" },
    });
    expect(screen.getByLabelText("发送")).toBeTruthy();
  });

  it("用户消息靠右成气泡,AI 回答靠左整幅铺开", () => {
    /**
     * 两条都被我破坏过,所以都要守住:
     *   一次把两者都改成全宽左对齐,用户消息和 AI 回答分不清;
     *   一次给 AI 回答套上设计系统右侧停靠面板的窄气泡(max-w-[88%] + 边框),
     *   那是给 320px 侧栏设计的样式,搬到整页对话上,回答被压在一个小框里 ——
     *   这正是用户反馈的「输出框太小」。
     */
    const { container } = render(
      <ChatPanel
      channel="chat"
        models={MODELS}
        conversations={CONVERSATIONS}
        activeConversationId="c1"
        initialTurns={TURNS}
      />,
    );

    const user = screen.getByText("你好").closest("div.flex.w-full");
    const assistant = screen
      .getByText("你好,有什么可以帮你的?")
      .closest("div.flex.w-full");

    expect(user?.className).toContain("items-end");
    expect(assistant?.className).toContain("items-start");

    // 用户消息:气泡 + brand-tint + 限宽
    const userBubble = screen.getByText("你好");
    expect(userBubble.className).toContain("rounded-bubble");
    expect(userBubble.className).toContain("bg-brand-tint");
    expect(userBubble.className).toContain("max-w-[88%]");

    // AI 回答:整幅铺开,不套气泡、不限宽
    const answer = screen.getByText("你好,有什么可以帮你的?");
    expect(answer.className).toContain("w-full");
    expect(answer.className).not.toContain("rounded-bubble");
    expect(answer.className).not.toContain("max-w-[88%]");
    // 全页面只应有一个气泡 —— 用户那条
    expect(container.querySelectorAll(".rounded-bubble").length).toBe(1);
  });

  it("没有历史对话时也能渲染", () => {
    render(
      <ChatPanel
      channel="chat"
        models={MODELS}
        conversations={[]}
        activeConversationId={null}
        initialTurns={[]}
      />,
    );
    expect(screen.getByText(/输入内容开始对话/)).toBeTruthy();
    expect(screen.getByText(/还没有对话记录/)).toBeTruthy();
  });

  it("没有可用模型时给出明确指引,而不是空白", () => {
    render(
      <ChatPanel
      channel="chat"
        models={[]}
        conversations={[]}
        activeConversationId={null}
        initialTurns={[]}
      />,
    );
    // 空状态不能只说「没有」——必须给出可点的下一步。
    // 新用户注册进来第一眼看到的就是这个页面,说不清怎么办等于把人挡在门外。
    expect(screen.getByText(/还差一步/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /去配置模型服务/ });
    expect(link.getAttribute("href")).toBe("/settings/models");
  });

  it("失败留痕的消息(内容为空、带错误)不会让整页崩掉", () => {
    // 生产库里真实存在这种行:调用失败时 content 为空,error_message 有值
    render(
      <ChatPanel
      channel="chat"
        models={MODELS}
        conversations={CONVERSATIONS}
        activeConversationId="c1"
        initialTurns={[
          {
            id: "m3",
            role: "assistant",
            content: "",
            inputTokens: null,
            outputTokens: null,
            latencyMs: 78,
            error: "接口或模型不存在(HTTP 404)",
          },
        ]}
      />,
    );
    expect(screen.getByText(/HTTP 404/)).toBeTruthy();
  });
});
