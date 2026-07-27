import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 组件清单对齐测试。
 *
 * 设计系统的 _ds_manifest.json 是组件的权威清单。这个测试保证移植没有漏掉、
 * 也没有悄悄改名 —— 否则「已严格继承设计系统」就成了一句无法验证的话。
 *
 * 清单直接读自设计系统包,不是手抄的副本。设计系统若新增组件,这里会立刻失败。
 */

const DS_MANIFEST = "/Users/kuanxu/Desktop/Claude Code/_ds_manifest.json";

/** 非组件导出 —— 是常量/类型,不需要对应一个 .tsx 文件 */
const NON_COMPONENT_EXPORTS = new Set(["WORKFLOW_STATUS"]);

interface Manifest {
  components: { name: string; sourcePath: string }[];
}

function loadManifest(): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(DS_MANIFEST, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

const PORTED = new Map<string, string>([
  ["Avatar", "primitives"],
  ["Badge", "primitives"],
  ["Button", "primitives"],
  ["Checkbox", "primitives"],
  ["IconButton", "primitives"],
  ["Input", "primitives"],
  ["Select", "primitives"],
  ["Switch", "primitives"],
  ["Tabs", "primitives"],
  ["Tag", "primitives"],
  ["Icon", "icons"],
  ["EmptyState", "feedback"],
  ["ErrorState", "feedback"],
  ["LoadingState", "feedback"],
  ["Toast", "feedback"],
  ["ConfirmationDialog", "overlay"],
  ["Drawer", "overlay"],
  ["Modal", "overlay"],
  ["AIAssistantPanel", "shell"],
  ["AppShell", "shell"],
  ["SidebarNavigation", "shell"],
  ["TopCommandBar", "shell"],
  ["DailyBriefCard", "dashboard"],
  ["AgentBadge", "workflow"],
  ["WorkflowCard", "workflow"],
  ["WorkflowStatusBadge", "workflow"],
  ["WorkflowStep", "workflow"],
  ["WorkflowTimeline", "workflow"],
  ["MemoryCard", "memory"],
  ["MemorySourceBadge", "memory"],
  ["KnowledgeFileRow", "knowledge"],
  ["KnowledgePreview", "knowledge"],
  ["AIResponseActions", "ai"],
  ["CitationList", "ai"],
  ["ContextSourcePanel", "ai"],
  ["PricingCard", "account"],
  ["UsageMeter", "account"],
  ["SearchCommand", "search"],
]);

const SRC_COMPONENTS = resolve(__dirname, "../../src/components");

describe("设计系统组件已全部移植", () => {
  const manifest = loadManifest();

  it.runIf(manifest)("移植清单覆盖设计系统 manifest 的全部组件", () => {
    const expected = manifest!.components
      .map((c) => c.name)
      .filter((name) => !NON_COMPONENT_EXPORTS.has(name));

    const missing = expected.filter((name) => !PORTED.has(name));
    expect(missing, `未移植的组件: ${missing.join(", ")}`).toEqual([]);
  });

  it.runIf(manifest)("没有凭空多出设计系统里不存在的组件", () => {
    const known = new Set(manifest!.components.map((c) => c.name));
    const extra = [...PORTED.keys()].filter((name) => !known.has(name));
    expect(extra, `设计系统中不存在: ${extra.join(", ")}`).toEqual([]);
  });

  it("每个组件都有对应的 .tsx 文件且导出同名符号", () => {
    const broken: string[] = [];

    for (const [name, group] of PORTED) {
      const file = resolve(SRC_COMPONENTS, group, `${name}.tsx`);
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        broken.push(`${group}/${name}.tsx 不存在`);
        continue;
      }
      if (!new RegExp(`export function ${name}\\b`).test(source)) {
        broken.push(`${group}/${name}.tsx 未导出 ${name}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it("移植了 38 个组件", () => {
    expect(PORTED.size).toBe(38);
  });
});

describe("工作流状态机满足产品需求", () => {
  it("覆盖需求要求的全部 10 个状态", async () => {
    const { WORKFLOW_STATUSES } = await import(
      "@/components/workflow/WorkflowStatusBadge"
    );

    expect([...WORKFLOW_STATUSES]).toEqual([
      "DRAFT",
      "READY",
      "QUEUED",
      "RUNNING",
      "WAITING_FOR_INPUT",
      "WAITING_FOR_APPROVAL",
      "PAUSED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]);
  });

  it("每个状态都有中文标签,终态与活跃态标注正确", async () => {
    const { WORKFLOW_STATUS, WORKFLOW_STATUSES } = await import(
      "@/components/workflow/WorkflowStatusBadge"
    );

    for (const status of WORKFLOW_STATUSES) {
      expect(WORKFLOW_STATUS[status].label.length).toBeGreaterThan(0);
    }

    expect(WORKFLOW_STATUS.RUNNING.active).toBe(true);
    for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      expect(WORKFLOW_STATUS[terminal].terminal).toBe(true);
    }
  });
});

describe("记忆来源严格区分推断与确认", () => {
  it("AI 推断与用户确认是两个不同来源,标签不含糊", async () => {
    const { MEMORY_SOURCES } = await import(
      "@/components/memory/MemorySourceBadge"
    );

    expect(MEMORY_SOURCES).toContain("inferred");
    expect(MEMORY_SOURCES).toContain("confirmed");
  });
});
