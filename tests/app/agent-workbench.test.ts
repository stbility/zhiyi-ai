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

describe("智能体页面是整幅单栏 —— 右边不许挂东西", () => {
  /**
   * 这一组守的是我连着做错的两版布局。
   *
   *   第一版  右边固定挂 380px 产物栏。工作区为空时就是一大块白,
   *           既没信息又把对话挤窄。
   *   第二版  改成「有产物才平铺成两块等宽窗格」。听着讲得通,
   *           算术却更糟 —— 见下面那条断言里的数字。
   *
   * 根子是 ChatPanel 里那个 224px(w-56)的会话侧栏:它已经在对话区
   * 里面了。Claude Code 桌面版是**三块各自独立的窗格**(会话列表 /
   * 对话 / 预览),而且预览是**需要时弹出来**的,不是钉死在侧边。
   */
  it("页面里没有任何侧栏容器", () => {
    expect(AGENT_PAGE, "右边又挂上东西了").not.toMatch(/<aside/);
  });

  it("ChatPanel 拿到整幅宽度,不被侧栏挤窄", () => {
    // 不许再套一层 flex-1 的包装 —— 那正是给同级侧栏腾地方的写法
    expect(AGENT_PAGE).not.toMatch(/flex min-w-0 flex-1 overflow-hidden/);
  });

  it("和 AI 助手页面用同一种外壳 —— 都是整幅", () => {
    const 壳 = /<div className="flex h-full w-full overflow-hidden">/;
    expect(ASSISTANT_PAGE).toMatch(壳);
    // 智能体页外壳升级为纵向布局:底部是外部执行记录面板(内滚),
    // 聊天区仍是整幅单栏 —— 不引入右侧栏(见 224px 教训)
    expect(AGENT_PAGE).toMatch(/flex h-full w-full flex-col overflow-hidden/);
    expect(AGENT_PAGE).toMatch(/外部执行记录/);
    expect(AGENT_PAGE).toMatch(/ExecutionFeed/);
    // 底部面板用 border-t 横向分隔,不是 w-[NNNpx] 侧栏
    expect(AGENT_PAGE).toMatch(/border-t/);
    expect(AGENT_PAGE).not.toMatch(/border-l/);
  });

  it("对话区宽度的算术留在代码里,不是只写在提交信息里", () => {
    // 下一个人(很可能还是我)会想「右边加个预览多好」。
    // 那个 224px 必须就地看得到,否则他会重新算错一遍。
    expect(AGENT_PAGE).toMatch(/224px/);
  });
});

describe("产物预览是弹出层,不是常驻栏", () => {
  it("工具行里成功写入的那一行可以点开", () => {
    expect(CHAT_PANEL).toMatch(/t\.name === "write_file"/);
    expect(CHAT_PANEL).toMatch(/setPreviewOpen\(true\)/);
  });

  it("弹出层用 fixed 覆盖,不参与页面布局 —— 对话区一寸不让", () => {
    const 层 = CHAT_PANEL.slice(CHAT_PANEL.indexOf("previewOpen && workspace"));
    expect(层).toMatch(/fixed inset-0/);
    // 一旦写成 flex-1 / w-[NNNpx] 这类,它就又开始占宽度了
    expect(层, "预览层又变成占位的栏了").not.toMatch(/flex-1 overflow-y-auto border-l/);
  });

  it("Esc 能关掉 —— 否则键盘用户被困在里面", () => {
    expect(CHAT_PANEL).toMatch(/e\.key === "Escape"/);
  });

  it("复用工作区页面同一个组件,不另起一套", () => {
    expect(CHAT_PANEL).toMatch(/<WorkspaceBrowser/);
  });

  it("工作区还没取到时不给点 —— 点开一个空层比不能点更糟", () => {
    expect(CHAT_PANEL).toMatch(/workspace\?\.files\.length \?\? 0\) > 0/);
  });

  it("AI 助手页面不传 workspace —— 它本来就不产生副作用", () => {
    // 正向对照:少了这条,「智能体有预览」可能因为两个页面又变成
    // 同一个东西而碰巧成立
    expect(ASSISTANT_PAGE).not.toMatch(/workspace/);
    expect(AGENT_PAGE).toMatch(/loadWorkspaceForConversation/);
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
