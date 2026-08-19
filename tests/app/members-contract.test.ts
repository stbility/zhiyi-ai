import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 成员管理契约测试(阶段 2,2026-08-11)。
 *
 * 守的契约:
 *   1. actions 只操作 memberships 表(不动 organizations/其它表)
 *   2. 权限文案明确:邀请/改角色/移除都提示「只有所有者或管理员」
 *   3. RLS 错误码处理:42501 权限、23505 重名
 *   4. 页面从 memberships join profiles 读成员(真实数据)
 */

const ACTIONS = readFileSync(
  resolve(__dirname, "../../src/app/(app)/settings/members/actions.ts"),
  "utf8",
);
const PAGE = readFileSync(
  resolve(__dirname, "../../src/app/(app)/settings/members/page.tsx"),
  "utf8",
);

describe("成员管理", () => {
  it("actions 只写 memberships 表(不越权动其它表)", () => {
    // 写操作只出现在 memberships 上
    const writes = ACTIONS.match(/from\("([a-z_]+)"\)\.(insert|update|delete)/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).toMatch(/memberships/);
    }
  });

  it("权限提示明确:只有所有者或管理员可操作", () => {
    expect(ACTIONS).toMatch(/只有组织所有者或管理员可以邀请成员/);
    expect(ACTIONS).toMatch(/只有组织所有者或管理员可以修改角色/);
    expect(ACTIONS).toMatch(/只有组织所有者或管理员可以移除成员/);
  });

  it("RLS 错误码处理:42501 权限、23505 重名", () => {
    expect(ACTIONS).toContain('error.code === "42501"');
    expect(ACTIONS).toContain('error.code === "23505"');
  });

  it("页面从 memberships + profiles 读真实成员(不请求不存在的 email)", () => {
    expect(PAGE).toMatch(/from\("memberships"\)/);
    expect(PAGE).toMatch(/from\("profiles"\)/);
    // profiles 表真实 schema 无 email 列(0001:id/display_name/avatar_url/locale),
    // 页面只展示 profiles 真实字段,不得再请求 profiles.email
    expect(PAGE).not.toMatch(/profiles \(/);
    expect(PAGE).not.toMatch(/\.select\(\s*"[^"]*\bemail\b/);
    expect(PAGE).toMatch(/role/);
  });

  it("邀请需对方已注册(经 admin.listUsers 从 auth.users 查 email,不再查 profiles.email)", () => {
    expect(ACTIONS).toMatch(/createSupabaseAdminClient/);
    expect(ACTIONS).toMatch(/listUsers/);
    expect(ACTIONS).toMatch(/尚未注册智一 AI/);
    expect(ACTIONS).not.toMatch(/from\("profiles"\)/);
  });
});
