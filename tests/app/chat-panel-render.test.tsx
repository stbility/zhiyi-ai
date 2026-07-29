import { render, screen } from "@testing-library/react";
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
    // 左下控件
    expect(screen.getByText("添加文件夹")).toBeTruthy();
    expect(screen.getByText("发送")).toBeTruthy();
  });

  it("没有历史对话时也能渲染", () => {
    render(
      <ChatPanel
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
        models={[]}
        conversations={[]}
        activeConversationId={null}
        initialTurns={[]}
      />,
    );
    expect(screen.getByText("还没有可用的模型")).toBeTruthy();
  });

  it("失败留痕的消息(内容为空、带错误)不会让整页崩掉", () => {
    // 生产库里真实存在这种行:调用失败时 content 为空,error_message 有值
    render(
      <ChatPanel
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
