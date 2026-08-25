import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 两条通道必须在结构上分开 —— 这是一组反向守卫。
 *
 * 智一 AI 有两件不同的事:
 *   /assistant + /api/chat    AI 助手 —— 想清楚一件事,不产生副作用
 *   /agent     + /api/agent   智能体  —— 干成一件事,产物写进工作区
 *
 * 这是 Claude 的分法:claude.ai 是思考伙伴,Claude Code 是工程师,
 * 两个真正不同的产品、两套不同的能力面 —— claude.ai 那些界面
 * 默认不会改你的仓库、不跑你的 shell、不提交代码。
 *
 * 此前这两件事挤在一起:
 *   · 服务端一个端点,靠请求体里 `agent: true` 分岔
 *   · 前端一个输入框,靠 localStorage 里一个开关决定发不发这个字段
 *
 * 两个后果都真实发生过,而且反复发生:
 *   1. 改智能体那一侧,顺手动到共用代码,AI 助手跟着坏
 *   2. 开关状态用户看不见(它默认持久化),于是在 AI 助手页打的每一句话
 *      都在悄悄走智能体循环,而界面上没有任何东西告诉他
 *
 * 但**入口检查不能跟着分家**。鉴权、限流、服务商归属、对话归属、附件落库、
 * 上下文装配、用户消息留痕 —— 两条线一字不差地都要做。复制一份的话,
 * 两份必然慢慢走样,而走样的那一侧就是下一个安全缺口。
 * 所以下面既守「执行形态必须分开」,也守「入口检查必须共用」。
 */

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

const CHAT_ROUTE = read("src/app/api/chat/route.ts");
const AGENT_ROUTE = read("src/app/api/agent/route.ts");
const PREFLIGHT = read("src/lib/ai/turn-preflight.ts");
const CHAT_PANEL = read("src/components/app/ChatPanel.tsx");
const ASSISTANT_PAGE = read("src/app/(app)/assistant/page.tsx");
const AGENT_PAGE = read("src/app/(app)/agent/page.tsx");

describe("执行形态必须分开", () => {
  it("对话路由不碰智能体 —— 一行都不能有", () => {
    expect(CHAT_ROUTE).not.toMatch(/runAgentTurn/);
    expect(CHAT_ROUTE).not.toMatch(/agent-turn/);
    // 请求体里那个分岔字段也不能回来
    expect(CHAT_ROUTE).not.toMatch(/parsed\.data\.agent/);
  });

  it("智能体走自己的路由", () => {
    expect(AGENT_ROUTE).toMatch(/runAgentTurn/);
  });

  it("智能体路由挡住不支持工具调用的服务商", () => {
    // 挡在入口,而不是等跑到第一步再失败 —— 一个必然失败的任务
    // 不该被开始,更不该让用户先看几十秒「正在思考」
    expect(AGENT_ROUTE).toMatch(/supportsToolCalling/);
  });
});

describe("入口检查必须共用,不能各写一份", () => {
  it("两条路由都走同一个 preflightTurn", () => {
    expect(CHAT_ROUTE).toMatch(/preflightTurn\(request,\s*"chat"\)/);
    expect(AGENT_ROUTE).toMatch(/preflightTurn\(request,\s*"agent"\)/);
  });

  const 必须留在共用层 = [
    [/checkRateLimit/, "限流 —— 唯一会造成直接金钱损失的缺口"],
    [/loadProviderCipher/, "密钥读取必须在 RLS 判权之后"],
    [/conv\.organization_id !== organizationId/, "跨组织对话会污染计费依据"],
    [/conversation_attachments/, "附件存不下就必须中止,不能让模型看不到代码还照常回答"],
    [/messages\.insert\(user\)|role: "user"/, "用户消息先落库"],
  ] as const;

  for (const [pattern, why] of 必须留在共用层) {
    it(`共用层里有 ${pattern.source} —— ${why}`, () => {
      expect(PREFLIGHT).toMatch(pattern);
    });
  }

  it("两条路由都不自己重做这些检查", () => {
    // 复制一份的话,两份会慢慢走样,而走样的那一侧就是下一个缺口
    for (const [name, code] of [
      ["chat", CHAT_ROUTE],
      ["agent", AGENT_ROUTE],
    ] as const) {
      expect(code, `${name} 路由自己调了限流,应该走共用层`).not.toMatch(
        /checkRateLimit/,
      );
      expect(code, `${name} 路由自己插了用户消息,应该走共用层`).not.toMatch(
        /conversation_attachments/,
      );
    }
  });

  it("限流按通道分开计数", () => {
    // 智能体一轮就是十几次上游调用。和对话共用一个计数器的话,
    // 跑一次智能体会把对话额度顺带打光,而用户完全不知道
    // AI 助手为什么突然说「请求过于频繁」
    expect(PREFLIGHT).toMatch(/checkRateLimit\(`\$\{channel\}:\$\{user\.id\}`\)/);
  });

  it("先判组织归属,再判通道归属", () => {
    // 跨组织是安全问题(计费依据被污染),跨通道只是走错了页面。
    // 顺序反了的话,一个越权请求会先撞上「请到智能体页面继续」——
    // 一句与真实原因完全无关的提示,而真正的越权反而没被说出来。
    const 组织 = PREFLIGHT.indexOf("conv.organization_id !== organizationId");
    const 通道 = PREFLIGHT.indexOf("conv.channel !== channel");
    expect(组织).toBeGreaterThan(-1);
    expect(通道).toBeGreaterThan(-1);
    expect(组织, "通道检查排到了组织检查前面").toBeLessThan(通道);
  });
});

describe("前端也要分开", () => {
  it("端点由通道决定:agent 走异步队列,chat 走 SSE 同步", () => {
    // agent 通道:异步入队 /api/agent/runs(长任务脱离 300s,Runner 执行)
    expect(CHAT_PANEL).toMatch(/channel === "agent"/);
    expect(CHAT_PANEL).toMatch(/fetch\("\/api\/agent\/runs"/);
    // chat 通道:保持 SSE 同步流,行为不变
    expect(CHAT_PANEL).toMatch(/fetch\("\/api\/chat"/);
  });

  it("输入框上没有智能体开关了", () => {
    // 那个开关的状态存在 localStorage 里,用户看不见自己处在哪个模式。
    // 它导致的真实后果:在 AI 助手页打的每一句话都在悄悄走智能体循环。
    expect(CHAT_PANEL).not.toMatch(/zhiyi-agent-mode/);
    expect(CHAT_PANEL).not.toMatch(/agentMode/);
    expect(CHAT_PANEL).not.toMatch(/agent:\s*true/);
  });

  it("两个页面各挂各的通道", () => {
    expect(ASSISTANT_PAGE).toMatch(/channel="chat"/);
    expect(AGENT_PAGE).toMatch(/channel="agent"/);
  });

  it("两个页面各列各的历史,不互相串", () => {
    expect(ASSISTANT_PAGE).toMatch(/loadConversations\(org\.id, "chat"\)/);
    expect(AGENT_PAGE).toMatch(/loadConversations\(org\.id, "agent"\)/);
  });
});

describe("侧栏链接必须指回本通道", () => {
  /**
   * 用户报的 bug:「新对话点击跳转到 ai 助手的对话框」。
   *
   * 「新对话」和历史记录两处都写死成 /assistant —— 在智能体页面上点任何
   * 一个,人就被悄悄送到另一条通道去了。而两条通道的执行形态完全不同:
   * 一个写工作区,一个不碰。用户以为自己还在智能体页面,实际已经不是。
   */
  it("不写死 /assistant,由 channel 决定", () => {
    expect(CHAT_PANEL).toMatch(
      /const basePath = channel === "agent" \? "\/agent" : "\/assistant"/,
    );
    // 写死的字符串链接一处都不许留
    expect(CHAT_PANEL, "又写死了 /assistant 链接").not.toMatch(
      /href="\/assistant/,
    );
  });

  it("新对话与历史记录都用 basePath", () => {
    expect(CHAT_PANEL).toMatch(/href=\{`\$\{basePath\}\?c=new`\}/);
    expect(CHAT_PANEL).toMatch(/href=\{`\$\{basePath\}\?c=\$\{c\.id\}`\}/);
  });
});
