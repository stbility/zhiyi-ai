import { describe, expect, it } from "vitest";

import {
  canTransition,
  parseDefinition,
  WORKFLOW_STATUSES,
} from "@/lib/workflow/state-machine";

describe("工作流状态机迁移", () => {
  it("覆盖设计系统定义的 10 个状态", () => {
    expect(WORKFLOW_STATUSES).toEqual([
      "DRAFT",
      "READY",
      "QUEUED",
      "RUNNING",
      "WAITING_FOR_INPUT",
      "WAITING_FOR_APPROVAL",
      "PAUSED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]);
  });

  it("终态(COMPLETED/CANCELLED)没有任何出边", () => {
    expect(canTransition("COMPLETED", "READY")).toBe(false);
    expect(canTransition("COMPLETED", "FAILED")).toBe(false);
    expect(canTransition("CANCELLED", "QUEUED")).toBe(false);
  });

  it("主链路合法:草稿→就绪→入队→运行→完成", () => {
    expect(canTransition("DRAFT", "READY")).toBe(true);
    expect(canTransition("READY", "QUEUED")).toBe(true);
    expect(canTransition("QUEUED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransition("RUNNING", "FAILED")).toBe(true);
  });

  it("失败可重试,取消不可复活", () => {
    expect(canTransition("FAILED", "QUEUED")).toBe(true);
    expect(canTransition("PAUSED", "QUEUED")).toBe(true);
    expect(canTransition("DRAFT", "QUEUED")).toBe(false);
  });
});

describe("工作流定义解析", () => {
  it("合法定义通过,并保留顺序", () => {
    const def = parseDefinition({
      steps: [
        { id: "s1", title: "第一步", prompt: "做 A" },
        { id: "s2", title: "第二步", prompt: "做 B" },
      ],
    });
    expect(def.steps).toHaveLength(2);
    expect(def.steps[0]?.title).toBe("第一步");
  });

  it("空步骤列表被拒绝", () => {
    expect(() => parseDefinition({ steps: [] })).toThrow(/至少需要一个步骤/);
  });

  it("超 5 步被拒绝(v1 同步护栏)", () => {
    const steps = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      title: `步骤 ${i}`,
      prompt: `指令 ${i}`,
    }));
    expect(() => parseDefinition({ steps })).toThrow(/最多 5 步/);
  });

  it("标题或指令为空被拒绝", () => {
    expect(() => parseDefinition({ steps: [{ id: "s1", title: "", prompt: "x" }] })).toThrow();
    expect(() => parseDefinition({ steps: [{ id: "s1", title: "x", prompt: "" }] })).toThrow();
  });
});
