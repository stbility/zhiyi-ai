import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 报表页(reports)契约测试。
 *
 * 守的契约:
 *   1. 页面只读 eval_runs(真实数据),不造样例、不填占位 —— 无记录显示空态
 *   2. 通过率按真实 pass_rate 渲染(≥80% 绿 / ≥50% 黄 / 其余红)
 *   3. 设计系统守卫:全部样式走 token,不写死颜色值
 */

const PAGE = readFileSync(resolve(__dirname, "../../src/app/(app)/reports/page.tsx"), "utf8");
const COMPONENT = readFileSync(
  resolve(__dirname, "../../src/components/reports/ReportsDashboard.tsx"),
  "utf8",
);

describe("报表页", () => {
  it("数据源是 eval_runs(真实数据,不造样例)", () => {
    expect(PAGE).toMatch(/from\("eval_runs"\)/);
    expect(PAGE).toMatch(/pass_rate/);
    // 页面代码不出现「示例数据」「mock 数据」类实现(注释里的说明除外)
    expect(PAGE).not.toMatch(/示例数据|mock.*data|sampleData|dummyData/i);
  });

  it("空态如实显示,不画假图表", () => {
    expect(COMPONENT).toMatch(/还没有评测运行记录/);
    expect(COMPONENT).toMatch(/runs\.length === 0/);
  });

  it("通过率按档位着色(text-success/warning/danger),不写死色值", () => {
    expect(COMPONENT).toMatch(/text-success/);
    expect(COMPONENT).toMatch(/text-warning/);
    expect(COMPONENT).toMatch(/text-danger/);
    // 不出现裸色值(#xxx / rgb / 英文色名)
    expect(COMPONENT).not.toMatch(/#[0-9a-fA-F]{3,6}|rgb\(|\bred\b|\bgreen\b|\bblue\b/i);
  });

  it("设计系统组件:Badge tone / StatusLabel tone 用法正确", () => {
    expect(COMPONENT).toMatch(/<Badge tone="success">完成<\/Badge>/);
    expect(COMPONENT).toMatch(/<Badge tone="warning">部分<\/Badge>/);
    expect(COMPONENT).toMatch(/<StatusLabel tone="warning">运行中<\/StatusLabel>/);
  });
});
