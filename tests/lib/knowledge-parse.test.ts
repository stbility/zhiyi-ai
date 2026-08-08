import { describe, expect, it } from "vitest";

import {
  detectFileType,
  truncateKnowledgeText,
  KNOWLEDGE_TEXT_MAX_CHARS,
} from "@/lib/knowledge/parse";

describe("知识库解析", () => {
  it("按扩展名识别文件类型,不认识的归 other", () => {
    expect(detectFileType("2026 Q2 财务附表.pdf")).toBe("pdf");
    expect(detectFileType("部门访谈纪要.docx")).toBe("docx");
    expect(detectFileType("竞品定价页存档.md")).toBe("md");
    expect(detectFileType("会议录音转写.txt")).toBe("txt");
    expect(detectFileType("archive.tar.gz")).toBe("other");
  });

  it("正文超长截断并标注", () => {
    const result = truncateKnowledgeText("x".repeat(KNOWLEDGE_TEXT_MAX_CHARS + 100));
    expect(result.endsWith("…(截断)")).toBe(true);
    expect(result.length).toBe(KNOWLEDGE_TEXT_MAX_CHARS + "…(截断)".length);
  });

  it("短正文原样返回(去首尾空白)", () => {
    expect(truncateKnowledgeText("  内容  ")).toBe("内容");
  });
});
