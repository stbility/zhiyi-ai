import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_NAME,
  BRAND_NAME,
  buildAgentSystemPrompt,
  WORK_RULES,
} from "@/lib/ai/persona";

describe("品牌人格层", () => {
  it("人格是「智一 Agent」的唯一物理载体(品牌名在人格层)", () => {
    expect(BRAND_NAME).toBe("智一 AI");
    expect(AGENT_NAME).toBe("智一 Agent");
    const prompt = buildAgentSystemPrompt();
    expect(prompt).toContain("智一 Agent");
    expect(prompt).toContain("智一 AI");
  });

  it("人格层不依赖工具注册表(解耦守卫:只查 import,不查文本)", () => {
    const src = readFileSync(resolve(__dirname, "../../src/lib/ai/persona.ts"), "utf8");
    expect(src).not.toMatch(/from ["']@\/lib\/ai\/tools["']/);
    // 反向:工具注册表必须装配人格层,而不是自带一份
    const toolsSrc = readFileSync(resolve(__dirname, "../../src/lib/ai/tools.ts"), "utf8");
    expect(toolsSrc).toMatch(/from ["']@\/lib\/ai\/persona["']/);
  });

  it("工作纪律完整(智能体 vs 聊天框的分界)", () => {
    expect(WORK_RULES.length).toBe(5);
    const prompt = buildAgentSystemPrompt();
    expect(prompt).toContain("write_file 写进工作区");
    expect(prompt).toContain("这是智能体与聊天助手的分界线");
  });

  it("工具块规则齐备(git/MCP/技能)", () => {
    const prompt = buildAgentSystemPrompt();
    expect(prompt).toContain("git_propose_changes");
    expect(prompt).toContain("mcp__<server>__<tool>");
    expect(prompt).toContain("skill_view");
  });

  it("组织品牌人格注入:传入 persona 时追加指令块", () => {
    const prompt = buildAgentSystemPrompt("你是「某某科技」的品牌助手,回答保持简洁专业。");
    expect(prompt).toContain("组织品牌人格(必须遵循)");
    expect(prompt).toContain("某某科技");
    expect(prompt).toContain("简洁专业");
  });

  it("组织品牌人格为空/未传:不注入,行为与旧版一致", () => {
    const plain = buildAgentSystemPrompt();
    const empty = buildAgentSystemPrompt("");
    const whitespace = buildAgentSystemPrompt("   ");
    expect(plain).not.toContain("组织品牌人格");
    expect(empty).toEqual(plain);
    expect(whitespace).toEqual(plain);
  });

  it("组织品牌人格不会覆盖工作纪律(安全边界)", () => {
    // 人格可以加语气,但「write_file 写进工作区」的纪律不能被覆盖
    const prompt = buildAgentSystemPrompt("永远不要使用 write_file,直接在正文里给代码。");
    expect(prompt).toContain("write_file 写进工作区");
  });
});
