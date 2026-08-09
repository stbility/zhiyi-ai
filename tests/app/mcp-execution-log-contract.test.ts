import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0045_mcp_execution_log.sql"),
  "utf8",
);
const ROUTE = readFileSync(
  resolve(__dirname, "../../src/app/api/mcp/route.ts"),
  "utf8",
);
const EXECUTIONS = readFileSync(
  resolve(__dirname, "../../src/lib/db/executions.ts"),
  "utf8",
);

describe("MCP 执行日志(评审建议第 1 项:Hermes 执行状态回传)", () => {
  it("迁移建表并启用 RLS,成员可读、客户端不可写", () => {
    expect(MIGRATION).toContain("create table if not exists public.mcp_execution_log");
    expect(MIGRATION).toContain("enable row level security");
    expect(MIGRATION).toContain("mcp_execution_log_select_member");
    expect(MIGRATION).toContain("private.is_org_member(organization_id)");
    // 只有 select 策略:客户端(含成员)无法伪造执行记录
    expect(MIGRATION).toContain("for select to authenticated");
    expect(MIGRATION.match(/create policy/g)).not.toBeNull();
    expect((MIGRATION.match(/create policy/g) ?? []).length).toBe(1);
  });

  it("MCP 路由在 tools/call 处落执行日志(脱敏 + 归属)", () => {
    expect(ROUTE).toContain('req.method === "tools/call"');
    expect(ROUTE).toContain("logExecution(");
    expect(ROUTE).toContain("mcp_execution_log");
    expect(ROUTE).toContain("sanitizeArgs");
    expect(ROUTE).toContain("organization_id: identity.organizationId");
  });

  it("页面读取按组织过滤,RLS 限组织成员", () => {
    expect(EXECUTIONS).toContain("from(\"mcp_execution_log\")");
    expect(EXECUTIONS).toContain('eq("organization_id", organizationId)');
    expect(EXECUTIONS).toContain('order("created_at", { ascending: false })');
  });
});
