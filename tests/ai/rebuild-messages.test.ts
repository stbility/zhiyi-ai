import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_REBUILD_MESSAGES } from "@/lib/ai/agent";
import {
  rebuildMessagesFromSteps,
  type RebuildStepRow,
} from "@/lib/ai/agent-turn";

function step(
  index: number,
  toolName: string | null,
  callId: string | null,
  args: unknown = {},
  preview = "result",
  ok = true,
): RebuildStepRow {
  return {
    step_index: index,
    tool_call_id: callId,
    tool_name: toolName,
    arguments: args,
    result_preview: preview,
    result_chars: preview.length,
    ok,
  };
}

describe("rebuildMessagesFromSteps(方案 B:续跑消息重建)", () => {
  it("空输入 → null(降级信号)", () => {
    expect(rebuildMessagesFromSteps([])).toBeNull();
  });

  it("单个工具步骤 → assistant tool_calls + tool 结果两条消息", () => {
    const rows = [step(100, "git_read_file", "call-1", { path: "README.md" }, "内容")];
    const msgs = rebuildMessagesFromSteps(rows)!;
    expect(msgs).toHaveLength(2);
    const [assistant, toolMsg] = msgs;
    expect(assistant?.role).toBe("assistant");
    expect((assistant!.tool_calls as unknown[])[0]).toMatchObject({
      id: "call-1",
      type: "function",
    });
    expect(toolMsg?.role).toBe("tool");
    expect(toolMsg?.tool_call_id).toBe("call-1");
    expect(toolMsg?.content).toBe("内容");
  });

  it("同一步多个工具 → 合并进同一个 assistant 消息", () => {
    const rows = [
      step(100, "git_list_files", "call-a", {}, "[目录] src"),
      step(101, "git_read_file", "call-b", { path: "x" }, "内容x"),
    ];
    const msgs = rebuildMessagesFromSteps(rows)!;
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.tool_calls).toHaveLength(2);
  });

  it("超过预算 → 最早的步骤压缩成摘要,最近的原样保留", () => {
    // 构造 MAX_REBUILD_MESSAGES + 10 个步骤
    const rows: RebuildStepRow[] = [];
    for (let i = 0; i < MAX_REBUILD_MESSAGES + 10; i++) {
      rows.push(step(100 * (i + 1), "git_list_files", `call-${i}`, {}, `结果${i}`));
    }
    const msgs = rebuildMessagesFromSteps(rows)!;
    // 第一条是摘要 user 消息
    const [head] = msgs;
    expect(head?.role).toBe("user");
    expect(String(head?.content)).toContain("此前已完成");
    // 摘要只含前 10 步
    expect(String(head?.content)).toContain("结果0");
    expect(String(head?.content)).not.toContain(`结果${MAX_REBUILD_MESSAGES}`);
    // 最近 60 条完整保留(assistant + tool 各 60)
    const recent = msgs.slice(1);
    expect(recent.filter((m) => m.role === "tool")).toHaveLength(MAX_REBUILD_MESSAGES);
    // 最近的最后一个结果在
    expect(recent.at(-1)?.content).toBe(`结果${MAX_REBUILD_MESSAGES + 9}`);
  });

  it("纯文本步骤(无工具)→ 不产生虚假轮次", () => {
    const rows = [
      step(100, "git_read_file", "call-1", {}, "内容"),
      step(200, null, null, null, "模型说的话", true),
    ];
    const msgs = rebuildMessagesFromSteps(rows)!;
    // 只有工具步骤的 2 条;纯文本步骤不重建为对话轮次
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(msgs.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("工具结果过长 → capToolResult 截断并告知", () => {
    const long = "x".repeat(40_000);
    const rows = [step(100, "git_read_file", "call-1", {}, long)];
    const msgs = rebuildMessagesFromSteps(rows)!;
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(String(toolMsg.content).length).toBeLessThanOrEqual(31_000);
    expect(String(toolMsg.content)).toContain("此处截断");
  });
});
