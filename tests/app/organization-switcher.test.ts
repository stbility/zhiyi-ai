import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 组织切换器契约测试(阶段 2 收口,2026-08-11)。
 *
 * 守的契约:
 *   1. getCurrentOrganization 读 cookie 选择,失效回退第一个
 *   2. cookie 只存 org id(不存角色/名字 —— 那些每次从库读)
 *   3. 切换 action 只写 cookie,不写库
 *   4. 单组织不渲染切换器(没得切)
 */

const QUERIES = readFileSync(resolve(__dirname, "../../src/lib/db/queries.ts"), "utf8");
const ACTIONS = readFileSync(
  resolve(__dirname, "../../src/app/(app)/organization-actions.ts"),
  "utf8",
);
const SWITCHER = readFileSync(
  resolve(__dirname, "../../src/components/app/OrganizationSwitcher.tsx"),
  "utf8",
);

describe("组织切换器", () => {
  it("getCurrentOrganization 读 cookie 选择,失效回退第一个", () => {
    expect(QUERIES).toMatch(/export async function getCurrentOrganization/);
    expect(QUERIES).toMatch(/cookieStore\.get/);
    expect(QUERIES).toMatch(/organizations\.find/);
    expect(QUERIES).toMatch(/organizations\[0\] \?\? null/);
  });

  it("cookie 只存 org id,不存角色/名字", () => {
    expect(QUERIES).toMatch(/const ORG_COOKIE = "zhiyi_current_org"/);
    // rememberOrganization 只 set id
    expect(QUERIES).toMatch(/cookieStore\.set\(ORG_COOKIE, organizationId/);
    // 不出现 role/name 写入 cookie 的迹象
    expect(QUERIES).not.toMatch(/cookieStore\.set\([^)]*role/i);
  });

  it("切换 action 只写 cookie,不写数据库", () => {
    expect(ACTIONS).toMatch(/rememberOrganization/);
    expect(ACTIONS).not.toMatch(/\.from\(/);
    expect(ACTIONS).not.toMatch(/\.rpc\(/);
  });

  it("单组织不渲染切换器(没得切)", () => {
    expect(SWITCHER).toMatch(/organizations\.length <= 1/);
    expect(SWITCHER).toMatch(/return null/);
  });

  it("切换后刷新页面(所有页面读 cookie 换上下文)", () => {
    expect(SWITCHER).toMatch(/window\.location\.reload\(\)/);
    expect(SWITCHER).toMatch(/onSwitch/);
  });

  it("server action 通过动态 import 调用(避免 client 静态依赖 server-only)", () => {
    const CHROME = readFileSync(
      resolve(__dirname, "../../src/components/app/AppChrome.tsx"),
      "utf8",
    );
    expect(CHROME).toMatch(/await import\(/);
    expect(CHROME).toMatch(/switchOrganization/);
    // OrganizationSwitcher 本身不 import server action
    expect(SWITCHER).not.toMatch(/organization-actions/);
  });
});
