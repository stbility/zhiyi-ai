import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 智能体页面必须是**工作台**,不是聊天框换个标题。
 *
 * 用户的原话:「是你复制 AI 助手页面冒充智能体,欺骗用户?」
 *
 * 后端确实不是复制的 —— 那一轮真的走了 /api/agent、真的建了工作区,
 * 库里查得到。但界面是:同样的气泡、同样的输入框,没有工作区视图、
 * 没有文件列表、没有步骤显示。用户在界面上**没有任何办法**分辨,
 * 于是那个怀疑完全合理。一个连产出物都不展示的页面,凭什么叫智能体。
 *
 * 这组守卫钉住四件事,前两件来自 Claude Code 官方做法:
 *   1. 思考是灰斜体内联文本,不是气泡框
 *   2. 工具执行用专门的可视组件呈现,不拼成一段话混进回答
 *   3. 智能体页面有产物栏,能看见文件
 *   4. 界面上不出现系统写的旁白
 */

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

const CHAT_PANEL = read("src/components/app/ChatPanel.tsx");
const AGENT_PAGE = read("src/app/(app)/agent/page.tsx");
const ASSISTANT_PAGE = read("src/app/(app)/assistant/page.tsx");

describe("思考过程按 Claude Code 的做法呈现", () => {
  /**
   * 官方做法(code.claude.com + 官方 issue):思考以**灰色斜体**内联在流里
   * 流式显示,默认折叠、可展开(终端里是 Ctrl+O)。
   *
   * 关键是它**不是一块与答案平级的内容**。此前这里是带边框、带底色、
   * 带圆角的盒子 —— 那个盒子把「模型在想」抬成了和答案并排的一块东西,
   * 可它本来就不是内容,是过程。
   */
  it("是灰斜体,不是气泡框", () => {
    const 思考块 = CHAT_PANEL.slice(
      CHAT_PANEL.indexOf("turn.role === \"assistant\" && turn.reasoning"),
      CHAT_PANEL.indexOf("{turn.tools && turn.tools.length > 0"),
    );
    expect(思考块.length).toBeGreaterThan(0);

    // 斜体是这套呈现的核心信号:这行字不是答案
    expect(思考块).toMatch(/italic/);
    // 不许再套盒子
    expect(思考块, "思考过程又被套回气泡框里了").not.toMatch(/bg-surface-2/);
    expect(思考块).not.toMatch(/rounded-control/);
  });

  it("默认折叠、可展开", () => {
    expect(CHAT_PANEL).toMatch(/<details/);
  });
});

describe("工具执行用可视组件,不是叙述文字", () => {
  it("按结构渲染工具名与结果,而不是拼成一句话", () => {
    // Claude Code 把工具调用渲染成专门的可视组件(文件 diff、结构化输出)。
    // 这里的等价物:一行一个工具,成功/失败图标 + 工具名 + 结果。
    expect(CHAT_PANEL).toMatch(/turn\.tools\.map/);
    expect(CHAT_PANEL).toMatch(/name=\{t\.ok \? "check" : "x"\}/);
  });

  it("工具行与回答正文是两个渲染位置", () => {
    // 拼进正文的话,用户分不出哪句是模型说的、哪句是系统记的
    const 工具位置 = CHAT_PANEL.indexOf("turn.tools.map");
    const 正文位置 = CHAT_PANEL.indexOf("{linkify(turn.content)}");
    expect(工具位置).toBeGreaterThan(-1);
    expect(正文位置).toBeGreaterThan(-1);
    expect(工具位置).not.toBe(正文位置);
  });
});

describe("智能体页面能看见产物", () => {
  it("有产物栏,直接挂工作区浏览器", () => {
    expect(AGENT_PAGE).toMatch(/WorkspaceBrowser/);
    expect(AGENT_PAGE).toMatch(/loadWorkspaceForConversation/);
  });

  it("AI 助手页面没有产物栏 —— 它本来就不产生副作用", () => {
    // 这一条是上一条的**正向对照**。少了它,「智能体页面有工作区」
    // 这个断言可能因为两个页面又变成同一个东西而碰巧成立。
    expect(ASSISTANT_PAGE).not.toMatch(/WorkspaceBrowser/);
  });

  it("没有产物时不留空窗格", () => {
    // 用户的原话:「不是你现在设计的右边一个空白框破坏整体视觉效果」。
    // 那个 380px 的框在工作区为空时就是一大块白 —— 不提供任何信息,
    // 只是把对话挤窄。而空工作区本来就是正常状态(工作区用到时才建),
    // 不需要用一个框去宣告它。
    expect(AGENT_PAGE).toMatch(/workspace\.files\.length > 0/);
    // 渲染必须挂在这个条件上,不能无条件铺出来
    expect(AGENT_PAGE).toMatch(/有产物 && workspace \? \(/);
  });

  it("产物窗格与对话**等宽平铺**,不是挂在边上的一条", () => {
    // Claude Code 桌面版是一套可平铺的窗格。此前这里写死 w-[380px],
    // 产物被压在一条窄边里,预览的 HTML 根本看不清。
    const 产物栏 = AGENT_PAGE.slice(AGENT_PAGE.indexOf("<aside"));
    expect(产物栏).toMatch(/flex-1/);
    expect(产物栏, "又写死成固定窄宽了").not.toMatch(/w-\[\d+px\]/);
  });

  it("产物窗格不给用户出主意", () => {
    expect(AGENT_PAGE).not.toMatch(/试试|不妨|建议你|帮你写/);
  });
});

describe("界面上不出现系统写的旁白", () => {
  const 旁白 = [
    /智能体运行中/,
    /已运行 \$\{?[^}]*\}? ?秒/,
    /正在等待模型返回第一步/,
    /本次运行改用过/,
    /产出的文件都在工作区里/,
  ];

  for (const 句 of 旁白) {
    it(`不出现「${句.source}」`, () => {
      expect(CHAT_PANEL).not.toMatch(句);
      expect(AGENT_PAGE).not.toMatch(句);
    });
  }
});
