import { describe, expect, it, vi } from "vitest";

/**
 * 智能体系统提示词的硬约束。
 *
 * 起因是一次真实回归:我把 maxSteps 从 12 压到 3 时,在提示词里写了
 * 「**你只有 3 步**……务必把工具调用合并……不要例行公事地先探一遍」。
 * 后来我把 maxSteps 改回 12,**却忘了改提示词**。
 *
 * 两个后果,第二个才是致命的:
 *   1. 提示词说 3 步、代码是 12 步 —— 对不上
 *   2. 那段话在**逼模型少用工具**。一个被告知步数紧张的模型,
 *      理性的选择就是别浪费步数写文件、直接在正文里回答 ——
 *      于是产物跑进了对话框,而工作区是空的。
 *
 * 用户的原话:「智能体输出到对话框,不是在工作区」。他没说错,
 * 而且那正是这个产品与聊天助手的分界线 —— 贴在正文里的代码,
 * 用户还要手工复制粘贴,那等于没做。
 *
 * 所以这里守两件事:
 *   · write_file 的强制性不能被任何措辞削弱
 *   · 提示词里不得出现任何「省着点用工具」的暗示
 */

async function loadPrompt() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  const { AGENT_SYSTEM_PROMPT } = await import("@/lib/ai/tools");
  return AGENT_SYSTEM_PROMPT;
}

describe("write_file 的强制性", () => {
  it("明确要求产物写进工作区,而不是贴在正文里", async () => {
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/write_file/);
    expect(prompt).toMatch(/不(允许|要)?.{0,8}贴在回答正文里|正文里不出现文件内容/);
  });

  it("把它说成最重要的一条,不是并列的普通规则", async () => {
    // 排在第几、语气多强,直接决定模型会不会为了省事跳过它
    const prompt = await loadPrompt();
    expect(prompt).toMatch(/最重要的一条|绝不允许/);
  });
});

describe("提示词里不得有任何「省着点用工具」的暗示", () => {
  const FORBIDDEN: readonly [RegExp, string][] = [
    [/你只有\s*\d+\s*步/, "写死步数 —— 与 maxSteps 必然对不上,而且暗示要省"],
    [/务必把工具调用合并/, "逼模型少调工具"],
    [/不要例行公事/, "劝模型跳过 list_files"],
    [/不必先 list_files/, "同上"],
    [/一步只做一件小事/, "同上"],
    [/省(下|着)?步数/, "任何形式的步数焦虑"],
  ];

  for (const [pattern, why] of FORBIDDEN) {
    it(`不含「${pattern.source}」—— ${why}`, async () => {
      const prompt = await loadPrompt();
      expect(prompt).not.toMatch(pattern);
    });
  }

  it("三个工具的使用指引都还在,没有被「省步数」删掉", async () => {
    const prompt = await loadPrompt();
    for (const tool of ["write_file", "read_file", "list_files"]) {
      expect(prompt, `${tool} 的指引不见了`).toMatch(new RegExp(tool));
    }
  });
});

describe("提示词与代码不得互相矛盾", () => {
  it("提示词不写死步数 —— 步数只由 DEFAULT_LIMITS 决定", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { AGENT_SYSTEM_PROMPT } = await import("@/lib/ai/tools");
    const { DEFAULT_LIMITS } = await import("@/lib/ai/agent");

    // 只要提示词里出现「N 步」这种写法,就会和 DEFAULT_LIMITS.maxSteps
    // 各说各话 —— 改一处忘另一处是必然,不是偶然。
    // 正确做法是提示词里根本不提步数。
    const 写死的步数 = /(\d+)\s*步/.exec(AGENT_SYSTEM_PROMPT);
    expect(
      写死的步数,
      写死的步数
        ? `提示词写死了「${写死的步数[0]}」,而 maxSteps 是 ${DEFAULT_LIMITS.maxSteps}`
        : "",
    ).toBeNull();
  });
});
