import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * 对话框里只能有模型自己说的话 —— 这是一组**反向守卫**。
 *
 * 起因是用户在生产上看到的一条助手消息:
 *
 *   messages.model_id = "deepseek-ai/deepseek-v4-flash"   ← 他选的
 *   messages.content  = "本次运行改用过:NVIDIA NIM · z-ai/glm-5.2。"
 *
 * 同一条记录里两个不一样的模型名。用户没有任何办法判断哪个是真的,
 * 而合理的结论就是「这段文字是编的」。
 *
 * 同一条消息里还有一句「产出的文件都在工作区里」—— 那次工作区是 0 文件。
 * 那不是措辞问题,那是一句纯粹的假话,而且是无条件打印的。
 *
 * 根子有两个:
 *   1. 智能体自动换模型,却把「换过」写成一句正文;留痕记的仍是用户选的那个
 *   2. 系统写的说明被**拼进了 content** —— 用户读到的就是「模型说的话」
 *
 * Claude 的做法是把这两类东西从结构上分开:系统消息与模型回复分属不同的
 * role / content block,各走各的通道,从不合并成一段文字。这里照做:
 *   · content 只装模型的输出
 *   · 护栏原因走 SSE 的 error 事件,界面在错误位置单独渲染
 *   · 模型不换,于是根本不存在「需要解释换了什么」这件事
 */

const SRC = (p: string) =>
  readFileSync(resolve(__dirname, "../../src", p), "utf8");

const AGENT = SRC("lib/ai/agent.ts");
const AGENT_TURN = SRC("lib/ai/agent-turn.ts");
const CHAT_PANEL = SRC("components/app/ChatPanel.tsx");

describe("智能体不换模型", () => {
  it("runAgent 只收一个模型,没有候选链", () => {
    // 形如 `candidates: readonly AgentModelOption[]` 的入参不能回来
    expect(AGENT).not.toMatch(/candidates\s*:\s*readonly/);
    expect(AGENT).toMatch(/model:\s*AgentModelOption;/);
  });

  it("循环里没有降级用的状态", () => {
    for (const dead of ["switchedModels", "deadProviders", "usedModels"]) {
      expect(AGENT, `${dead} 回来了 —— 降级链被加回去了`).not.toMatch(
        new RegExp(dead),
      );
    }
  });

  it("智能体这一轮不加载候选池", () => {
    // 候选池本身还在,给对话路径(AI 助手)用 —— 那条线是好的,不动。
    // 但智能体不准碰它。
    expect(AGENT_TURN).not.toMatch(/loadOrgCandidates|orderCandidates/);
    expect(AGENT_TURN).not.toMatch(/describeSwitch/);
  });
});

describe("留痕记的是实际跑的那个模型", () => {
  it("model_id 从跑过的那个对象上取,不是从入参取", () => {
    // 从 executed 取而不是从入参 model 取,是为了让「库里记的」和
    // 「真跑的」在代码上是同一个来源,而不是两个碰巧相等的值。
    // P1:executed 是 attempt 循环里更新的最终执行对象(selected 是
    // 用户选择的 requested;可能经 fallback 切换)。
    expect(AGENT_TURN).toMatch(/model_id:\s*executed\.modelId/);
    expect(AGENT_TURN).toMatch(/provider_id:\s*executed\.providerId/);
  });
});

describe("content 里不得出现系统写的文字", () => {
  it("summarizeRun 只返回模型说的话,不做任何拼接", { timeout: 60_000 }, async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { summarizeRun } = await import("@/lib/ai/agent");

    const summary = summarizeRun({
      answer: "已完成登录页。",
      steps: [
        {
          index: 1,
          text: "",
          tools: [
            {
              callId: "c1",
              name: "write_file",
              ok: true,
              content: "已写入 src/login.tsx。",
            },
          ],
        },
      ],
      inputTokens: 1,
      outputTokens: 1,
      haltReason: "已达到步数上限(12 步)。",
      toolSupport: null,
      messages: [],
    });

    expect(summary).toBe("已完成登录页。");
    // 工具执行的细节、护栏原因,一个字都不能进正文
    expect(summary).not.toContain("src/login.tsx");
    expect(summary).not.toContain("步数上限");
  });

  it("落库的 content 就是 summarizeRun 的返回值,中间不加东西", () => {
    // 曾经在这里拼过一段「本次模型把代码写在了回答里……建议换 GLM-5.2 重试」。
    // 两条都不能留:它进了 content(用户当成模型说的话),而且是在替用户
    // 拿主意(换哪个模型是他的事)。
    expect(AGENT_TURN).toMatch(/const summary = summarizeRun\(outcome\);/);
    expect(AGENT_TURN).not.toMatch(/summarizeRun\(outcome\)\s*\+/);
  });

  it("护栏原因走 error 通道,不进 content", () => {
    expect(AGENT_TURN).toMatch(
      /send\("error",\s*\{\s*message:\s*outcome\.haltReason\s*\}\)/,
    );
  });

  it("界面把 error 渲染在正文之外的位置", () => {
    // content 与 error 是两个字段、两个渲染位置 —— 这就是「不同的 role
    // 走不同通道」在这个前端里的落点。合并成一段文字,用户就分不出
    // 哪句是模型说的、哪句是系统说的。
    expect(CHAT_PANEL).toMatch(/\{linkify\(turn\.content\)\}/);
    expect(CHAT_PANEL).toMatch(
      /turn\.error && \(\s*<p className="text-error text-label">\{turn\.error\}<\/p>/,
    );
  });
});

describe("不打印无条件为真的假话", () => {
  const 假话 = [
    // 一个文件都没写时照样会打印 —— 用户实测「工作区 0 文件」那次就有这句
    /产出的文件都在工作区里/,
    /已完成的文件都已保存在工作区/,
    // 换模型的说明。模型已经不换了,这些话没有存在的余地
    /本次运行改用过/,
    /本次回复改用了/,
  ];

  for (const 句 of 假话) {
    it(`智能体链路上不出现「${句.source}」`, () => {
      for (const [name, code] of [
        ["agent.ts", AGENT],
        ["agent-turn.ts", AGENT_TURN],
      ] as const) {
        expect(code, `${name} 里又出现了这句`).not.toMatch(句);
      }
    });
  }
});

describe("护栏原因只陈述事实,不给建议", () => {
  it("不写「请…」「建议…」「换一个…」这类替用户拿主意的话", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { DEFAULT_LIMITS } = await import("@/lib/ai/agent");
    expect(DEFAULT_LIMITS.maxSteps).toBeGreaterThan(0);

    // 抓 agent.ts 里所有 haltReason 的赋值right-hand side
    const 赋值 = [...AGENT.matchAll(/haltReason\s*=\s*([^;]+);/g)].map(
      (m) => m[1] ?? "",
    );
    expect(赋值.length).toBeGreaterThan(0);
    for (const rhs of 赋值) {
      expect(rhs, "护栏原因里出现了建议性措辞").not.toMatch(
        /建议|请把|请到|试试|换一个|可以继续/,
      );
    }
  });
});
