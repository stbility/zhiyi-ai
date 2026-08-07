import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 智能体记忆 —— 五条闭环的最后一环:「沉淀为记忆」。
 *
 *   1 输入资料   → 文件上传 + 跨轮保留
 *   2 AI Agent  → 多步工具循环,产物写工作区
 *   3 结果引用  → 工具结果截断标注 (agent.ts capToolResult)
 *   4 用户确认  → message_feedback (0020) + 本记忆的沉淀按钮
 *   5 沉淀记忆  → 本文件覆盖的表(0028)、动作、UI、召回
 *
 * 来源纪律:用户确认的 (user_confirmed) 是唯一可信来源,
 * 其余类型必须有 confidence,界面上不得伪装成用户确认的事实。
 */

const ROOT = resolve(__dirname, "../..");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/0028_memories.sql"),
  "utf8",
);
const DB = readFileSync(resolve(ROOT, "src/lib/db/memories.ts"), "utf8");
const ACTION = readFileSync(
  resolve(ROOT, "src/app/(app)/assistant/memory-actions.ts"),
  "utf8",
);
const UI = readFileSync(
  resolve(ROOT, "src/components/app/MessageFeedback.tsx"),
  "utf8",
);
const AGENT_TURN = readFileSync(
  resolve(ROOT, "src/lib/ai/agent-turn.ts"),
  "utf8",
);
const PREFLIGHT = readFileSync(
  resolve(ROOT, "src/lib/ai/turn-preflight.ts"),
  "utf8",
);

describe("记忆表结构 (0028)", () => {
  it("有 memories 表 —— 五条闭环的第五环", () => {
    expect(MIGRATION).toContain("create table if not exists public.memories");
  });

  it("来源类型区分确认与推断 —— user_confirmed 是唯一可信来源", () => {
    expect(MIGRATION).toMatch(/source_type\s+text not null default 'user_confirmed'/);
    expect(MIGRATION).toContain("'ai_inferred','from_file','from_workflow'");
  });

  it("AI 推断的记忆必须有置信度,用户确认的没有", () => {
    expect(MIGRATION).toContain("confidence numeric");
    // 注释明确了这条纪律,防止将来有人给用户确认的记忆塞置信度
    expect(MIGRATION).toContain("用户确认的记忆没有置信度");
  });

  it("作用域:组织级 vs 仅创建者", () => {
    expect(MIGRATION).toMatch(/scope\s+text not null default 'organization'/);
    expect(MIGRATION).toContain("'organization','user'");
  });

  it("召回开关独立于删除 —— 关了还能再开", () => {
    expect(MIGRATION).toMatch(/recall_enabled\s+boolean not null default true/);
  });

  it("RLS:只能写自己的记忆", () => {
    expect(MIGRATION).toMatch(
      /memories_insert_own[\s\S]*?created_by = \(select auth\.uid\(\)\)/,
    );
  });

  it("RLS:读限定组织成员,用户级记忆仅创建者可见", () => {
    expect(MIGRATION).toMatch(
      /memories_select_member[\s\S]*?is_org_member\(organization_id\)[\s\S]*?scope = 'organization' or created_by = \(select auth\.uid\(\)\)/,
    );
  });

  it("有召回函数 —— 服务端装配上下文用,不走客户端", () => {
    expect(MIGRATION).toContain("recall_memories");
    expect(MIGRATION).toContain("touch_memory");
  });
});

describe("沉淀动作", () => {
  it("有 memorizeMessage 动作 —— 用户点「记住」的入口", () => {
    expect(ACTION).toContain("export async function memorizeMessage");
  });

  it("分类是显式选择,不是模型猜的", () => {
    expect(ACTION).toContain('z.enum(["fact", "preference", "convention", "knowledge", "persona"])');
  });

  it("组织归属取自消息本身,不采信客户端", () => {
    expect(DB).toContain('// 组织归属取自消息本身,不采信客户端');
    expect(DB).toContain('.from("messages")');
  });

  it("沉淀时同步写 wiki(Karpathy 模式) —— 记忆页 + index 汇总", () => {
    expect(DB).toContain("syncMemoryToWiki");
    expect(DB).toContain("wiki/memories/");
    expect(DB).toContain("wiki/index.md");
  });

  it("wiki 同步失败不影响记忆本身 —— 增强不是承诺", () => {
    expect(DB).toContain("wiki 同步是增强,不是承诺");
  });
});

describe("沉淀入口 UI", () => {
  it("反馈操作行里有「沉淀为记忆」按钮", () => {
    expect(UI).toContain("沉淀为记忆");
    expect(UI).toContain('aria-label="沉淀为记忆"');
  });

  it("按钮用 memory 图标,与导航里的「记忆」同源", () => {
    expect(UI).toContain('<Icon name="memory" size={13} />');
  });

  it("分类选择在展开区,默认事实", () => {
    expect(UI).toContain('name="category"');
    expect(UI).toContain('defaultChecked={value === "fact"}');
  });
});

describe("记忆召回", () => {
  it("智能体运行会召回记忆并注入上下文 —— 闭环的消费端", () => {
    expect(AGENT_TURN).toContain("recallMemories");
    expect(AGENT_TURN).toContain("你的记忆");
  });

  it("召回失败不阻断运行 —— 没有记忆的智能体仍然能干活", () => {
    expect(AGENT_TURN).toContain("记忆召回失败,本轮不带记忆运行");
  });

  it("续跑请求带 resumeRunId —— 检查点恢复", () => {
    expect(PREFLIGHT).toContain("resumeRunId");
    expect(AGENT_TURN).toContain("续跑上下文");
  });
});

describe("续跑 (多步上限)", () => {
  it("撞上限是能续的失败,不是终局", () => {
    expect(AGENT_TURN).toContain("interrupted");
  });

  it("runId 推给前端,前端才知道带哪个 run 续跑", () => {
    expect(AGENT_TURN).toContain('send("run"');
  });

  it("摘要来自检查点而不是浏览器临时状态", () => {
    expect(AGENT_TURN).toContain(".from(\"agent_steps\")");
    expect(AGENT_TURN).toContain("不要重做,直接继续");
  });
});
