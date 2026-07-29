import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET,
  buildContext,
  describeTrimming,
  type ContextFile,
  type ContextMessage,
} from "@/lib/ai/context";

/**
 * 上下文预算测试。
 *
 * 两个真实缺陷催生了这块代码:
 *   B4 附件只作用于发出的那一轮 —— 用户贴了项目,第二句问「改一下这个函数」,
 *      模型已经看不到代码。这让「智能体」落不了地,只是个失忆的聊天框。
 *   B7 历史固定取最近 50 条,长对话持续变贵变慢,没有任何上限管理。
 *      生产上已出现过单次输入 29799 token 的调用。
 *
 * 这里守住的是「装不下时怎么取舍」—— 取舍错了,模型看到的就是残缺信息,
 * 给出的建议全是错的,比不带更糟。
 */

const file = (path: string, size: number): ContextFile => ({
  path,
  content: "x".repeat(size),
});

const msg = (role: "user" | "assistant", text: string): ContextMessage => ({
  role,
  content: text,
});

describe("上下文装配", () => {
  it("项目文件跨轮保留,并标明路径", () => {
    const r = buildContext(
      [{ path: "src/app.ts", content: "export const a = 1;" }],
      [msg("user", "你好")],
    );
    expect(r.fileBlock).toContain("src/app.ts");
    expect(r.fileBlock).toContain("export const a = 1;");
    // 要让模型知道这些文件是后续提问的依据,而不是一次性的粘贴
    expect(r.fileBlock).toContain("后续提问");
  });

  it("没有文件时不产生空的文件块", () => {
    const r = buildContext([], [msg("user", "你好")]);
    expect(r.fileBlock).toBe("");
  });

  it("历史从最近往前装 —— 丢掉开头,绝不丢掉最近几轮", () => {
    // 正序截断会让模型看不到刚说过的话,那比丢掉开头糟得多
    // 预算刚好装得下后两条(5+2=7),装不下最早那条(50)
    const budget = { totalChars: 20, fileShare: 0 };
    const history = [
      msg("user", "最早的一句".repeat(10)),
      msg("assistant", "中间"),
      msg("user", "最近的一句"),
    ];
    const r = buildContext([], history, budget);

    const texts = r.messages.map((m) => m.content);
    expect(texts).toContain("最近的一句");
    expect(texts).toContain("中间");
    expect(texts.some((t) => t.startsWith("最早的一句最早的一句"))).toBe(false);
    // 顺序仍然是时间正序,不能倒着发给模型
    expect(texts[texts.length - 1]).toBe("最近的一句");
  });

  it("文件先占额度,剩下的才给历史", () => {
    const budget = { totalChars: 1000, fileShare: 0.7 };
    const r = buildContext(
      [file("a.ts", 600)],
      [msg("user", "y".repeat(500))],
      budget,
    );
    expect(r.stats.filesIncluded).toBe(1);
    // 文件占了 600+,历史那条 500 装不下
    expect(r.stats.messagesIncluded).toBe(0);
    expect(r.stats.messagesSkipped).toBe(1);
  });

  it("超预算的文件被跳过,并如实计数", () => {
    const budget = { totalChars: 1000, fileShare: 1 };
    const r = buildContext(
      [file("small.ts", 100), file("huge.ts", 5000), file("ok.ts", 200)],
      [],
      budget,
    );
    // 装得下的都装上,装不下的跳过 —— 不因为中间有个大文件就整个放弃
    expect(r.stats.filesIncluded).toBe(2);
    expect(r.stats.filesSkipped).toBe(1);
    expect(r.fileBlock).toContain("small.ts");
    expect(r.fileBlock).toContain("ok.ts");
    expect(r.fileBlock).not.toContain("huge.ts");
  });

  it("空内容的历史消息不进上下文", () => {
    // 失败调用会留下 content 为空的留痕记录,而 OpenAI 兼容接口不接受
    // 空内容消息 —— 带进去会让之后每一轮都失败,故障自我传染
    const r = buildContext([], [msg("assistant", ""), msg("user", "你好")]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.content).toBe("你好");
    // 空消息不算「被裁掉」,它本来就不该进
    expect(r.stats.messagesSkipped).toBe(0);
  });

  it("默认预算对常见模型都装得下", () => {
    // 不按单个模型的窗口定 —— 用户随时会切模型,按最小公约数走
    // 才不会「换个模型就报超长」
    expect(DEFAULT_BUDGET.totalChars).toBeLessThanOrEqual(400_000);
    expect(DEFAULT_BUDGET.fileShare).toBeGreaterThan(0.5);
  });
});

describe("裁剪说明", () => {
  it("有裁剪时说清楚裁了什么", () => {
    const text = describeTrimming({
      filesIncluded: 3,
      filesSkipped: 2,
      messagesIncluded: 10,
      messagesSkipped: 4,
      totalChars: 1000,
    });
    expect(text).toContain("2 个项目文件");
    expect(text).toContain("4 条消息");
  });

  it("没裁剪时不打扰用户", () => {
    expect(
      describeTrimming({
        filesIncluded: 1,
        filesSkipped: 0,
        messagesIncluded: 2,
        messagesSkipped: 0,
        totalChars: 100,
      }),
    ).toBeNull();
  });
});
