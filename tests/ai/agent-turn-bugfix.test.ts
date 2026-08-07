import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Bug 1 + Bug 2 修复的契约测试。
 *
 * Bug 1(平台档 503):智能体通道的凭据装配此前只查 ai_providers 表,
 *   平台档(providerId 形如 platform:…)在表里没有行 → 必然 503。
 *   修复:凭据装配分两支,平台档走 platformCredentialsFor(与 /api/chat
 *   同一个实现,授权判定只有一处)。
 * Bug 2(续跑校验缺失):续跑此前只按 run_id 查 agent_steps,不校验
 *   属于当前对话、不校验状态可续。修复:先查 agent_runs 校验
 *   conversation_id 一致 + status='interrupted' + resumable=true。
 */

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const AGENT_TURN = read("src/lib/ai/agent-turn.ts");
const PLATFORM_MODELS = read("src/lib/ai/platform-models.ts");
const CHAT_ROUTE = read("src/app/api/chat/route.ts");

describe("Bug 1:智能体通道平台档凭据", () => {
  it("agent-turn 的凭据装配分平台档/BYOK 两支", () => {
    expect(AGENT_TURN).toMatch(/isPlatformProviderId\(providerId\)/);
    expect(AGENT_TURN).toMatch(/platformCredentialsFor\(/);
    expect(AGENT_TURN).toMatch(/BYOK/);
  });

  it("平台档走共享的 platformCredentialsFor(授权判定单点)", () => {
    expect(PLATFORM_MODELS).toMatch(
      /export async function platformCredentialsFor/,
    );
    expect(PLATFORM_MODELS).toMatch(/free_only/);
    expect(PLATFORM_MODELS).toMatch(/loadPlatformCandidates/);
  });

  it("chat 通道复用共享实现,不再各自写一份", () => {
    // 修复前 chat/route.ts 有本地 platformCredentialsFor 副本;
    // 修复后应从 platform-models 导入,本地不再定义
    expect(CHAT_ROUTE).toMatch(/platformCredentialsFor,\s*\} from "@\/lib\/ai\/platform-models"/);
    expect(CHAT_ROUTE).not.toMatch(
      /async function platformCredentialsFor\s*\(/,
    );
  });

  it("平台档 503 文案区分于 BYOK —— 不再误导用户去改配置", () => {
    expect(AGENT_TURN).toMatch(/它属于平台免费档/);
    expect(AGENT_TURN).toMatch(/服务端未配置密钥,或你的组织不在该档位/);
  });
});

describe("Bug 2:续跑校验", () => {
  it("续跑前查询 agent_runs 校验归属与状态", () => {
    expect(AGENT_TURN).toMatch(/from\("agent_runs"\)/);
    expect(AGENT_TURN).toMatch(/conversation_id, status, resumable/);
  });

  it("只允许续「属于当前对话」的运行", () => {
    expect(AGENT_TURN).toMatch(/run\.conversation_id === conversationId/);
  });

  it("只允许续「被中断且标记可续」的运行", () => {
    expect(AGENT_TURN).toMatch(/run\.status === "interrupted"/);
    expect(AGENT_TURN).toMatch(/run\.resumable === true/);
  });

  it("校验不过时记 warn 且不注入续跑上下文", () => {
    expect(AGENT_TURN).toMatch(/续跑被拒:run 不属于当前对话、或状态不可续/);
    // resumeContext 只在 canResume 分支里被赋值
    expect(AGENT_TURN).toMatch(/if \(canResume\)/);
  });
});
