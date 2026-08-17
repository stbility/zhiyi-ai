import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 防回归:preflight-db.mts 必须是"纯直连验证"脚本。
 *
 * 背景(2026-08-17):曾有 pooler URL 自动转换逻辑(parseAndToPooler /
 * 生成连接串 / 替换 host)被写入,违反"只验证用户提供的 DATABASE_URL,
 * 绝不修改/替换/推测"的硬约束。本测试静态拦截任何回归。
 */

const SCRIPT = resolve(__dirname, "../scripts/preflight-db.mts");
const src = readFileSync(SCRIPT, "utf8");

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /parseAndToPooler/i, reason: "pooler 转换函数残留" },
  { pattern: /pooler\.supabase\.com/i, reason: "自动生成 pooler host" },
  { pattern: /projectRef/i, reason: "project-ref 推导" },
  { pattern: /aws-0-[\w-]*pooler/i, reason: "自动生成 pooler 主机名" },
  { pattern: /postgres\s*\+\s*['\"]\.['\"]/, reason: "username 自动拼接 .ref" },
  { pattern: /u\.hostname\s*=/, reason: "host 替换" },
  { pattern: /u\.port\s*=/, reason: "port 替换" },
  { pattern: /u\.username\s*=/, reason: "username 替换" },
  { pattern: /u\.password\s*=/, reason: "password 替换" },
  { pattern: /u\.database\s*=/, reason: "database 替换" },
];

describe("preflight-db.mts 纯直连防回归", () => {
  it("必须直接使用 process.env.DATABASE_URL", () => {
    expect(src).toContain("process.env.DATABASE_URL");
    expect(src).toContain("connectionString: DATABASE_URL");
  });

  it("不得包含任何自动 URL 转换逻辑", () => {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      expect(src.match(pattern), `${reason} (${pattern})`).toBeNull();
    }
  });

  it("不得输出完整连接串/凭据", () => {
    // 只允许脱敏 host 输出,禁止打印 DATABASE_URL 原文
    expect(src).not.toContain("console.log(DATABASE_URL)");
    expect(src).not.toContain("console.log(process.env.DATABASE_URL)");
    expect(src).toContain("safeHost");
  });

  it("失败处理只报告错误类别,不自动换连接串", () => {
    expect(src).toContain("FAIL(code)");
    expect(src).toContain("process.exit(1)");
    // 不得存在"失败后重新构造连接串"的路径
    expect(src).not.toContain("catch.*toPooler");
    expect(src).not.toContain("catch.*rewrite");
  });
});
