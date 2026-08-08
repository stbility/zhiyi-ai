import { describe, expect, it } from "vitest";

import { buildWorkflowMemoryContent } from "@/lib/workflow/memory-content";

describe("工作流产物沉淀为记忆", () => {
  it("短输出原样入库", () => {
    expect(buildWorkflowMemoryContent("  结论:A 方案可行。  ")).toBe(
      "结论:A 方案可行。",
    );
  });

  it("超长输出截断并标注", () => {
    const long = "x".repeat(3000);
    const result = buildWorkflowMemoryContent(long);
    expect(result.length).toBe(2000 + "…(截断)".length);
    expect(result.endsWith("…(截断)")).toBe(true);
  });

  it("空输出返回空串(调用方据此跳过沉淀)", () => {
    expect(buildWorkflowMemoryContent("   ")).toBe("");
  });
});
