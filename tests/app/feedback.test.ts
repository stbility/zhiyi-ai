import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 反馈飞轮的入口。
 *
 * 这是整条链路上唯一一件**现在不做以后补不回来**的事:历史对话随时能回捞,
 * 但用户当时想把这句话改成什么,过后没人记得。
 *
 * edited_text 是含金量最高的一列 —— 它给出「模型写的」和「用户要的」之间的差,
 * 既是评测用例,也是将来微调的成对样本。只有 👍/👎 的话,
 * 你知道好坏却不知道该往哪个方向改。
 */

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/0020_message_feedback.sql"),
  "utf8",
);
const ACTION = readFileSync(
  resolve(ROOT, "src/app/(app)/assistant/feedback-actions.ts"),
  "utf8",
);
const UI = readFileSync(
  resolve(ROOT, "src/components/app/MessageFeedback.tsx"),
  "utf8",
);
const PANEL = readFileSync(
  resolve(ROOT, "src/components/app/ChatPanel.tsx"),
  "utf8",
);

describe("反馈表结构", () => {
  it("三种判定都在,edited 是其中之一", () => {
    expect(MIGRATION).toMatch(/check \(verdict in \('good','bad','edited'\)\)/);
  });

  it("有 edited_text —— 没有它就只知道好坏,不知道该往哪改", () => {
    expect(MIGRATION).toContain("edited_text");
  });

  it("一人一条,改主意就更新 —— 不留一串互相矛盾的记录", () => {
    expect(MIGRATION).toMatch(/unique \(message_id, created_by\)/);
  });

  it("只能写自己的反馈,不能替别人打分", () => {
    expect(MIGRATION).toMatch(
      /message_feedback_insert_own[\s\S]*?created_by = \(select auth\.uid\(\)\)/,
    );
  });

  it("读限定在组织内 —— 反馈是团队资产,但不能跨组织可见", () => {
    expect(MIGRATION).toMatch(
      /message_feedback_select_member[\s\S]*?is_org_member\(organization_id\)/,
    );
  });
});

describe("提交动作", () => {
  it("组织归属取自消息本身,不采信客户端", () => {
    // 采信客户端的话,反馈会落到别的组织名下 —— 而后面要用它做评测集,
    // 归属错了整批数据都不可信
    expect(ACTION).toMatch(/\.from\("messages"\)[\s\S]{0,200}organization_id/);
    expect(ACTION).toContain("message.organization_id");
  });

  it("选了 edited 却没写改法,当场拦下", () => {
    // 存一条空的 edited 记录等于什么都没说,还会污染后续的样本集
    expect(ACTION).toMatch(/verdict === "edited" && !parsed\.data\.editedText/);
  });

  it("写库失败会留痕,不静默", () => {
    expect(ACTION).toContain("logDbFailure");
  });
});

describe("界面", () => {
  it("「我改成了这样」和 👍👎 同级出现,不是藏起来的次要功能", () => {
    expect(UI).toContain("我改成了这样");
    expect(UI).toMatch(/name="verdict" value="edited"/);
  });

  it("只挂在已落库的助手消息上", () => {
    // 正在生成的那条还没有真实 id,给它一个必然报错的按钮不如不给
    expect(PANEL).toContain("turn.dbId !== undefined");
    // 真实 id 必须由服务端回传,不能靠前端猜。
    //
    // 上一版是前端按 UUID 形状判断(isPersistedId):形状不像就把按钮
    // 藏起来。结果是**刚生成的回答上永远没有按钮** —— 而那正是唯一
    // 会打分的时刻,这个功能等于从没生效过。现在服务端在 done 事件里
    // 带回落库的 id,前端回填到 dbId。
    expect(PANEL).toMatch(/done\.messageId[\s\S]{0,200}dbId/);
  });
});
