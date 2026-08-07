#!/usr/bin/env node
/**
 * 部署环境自检。
 *
 * 限流与注册的 fail-open(rate-limit.ts:74/95/112)有一个共同前提:
 * 「未配置 service role 时返回放行,限流不该成为功能不可用的原因」
 * —— 但注释也承认「应当在部署检查里发现」。这个脚本就是那枚检查:
 *
 *   1. 必需的密钥类环境变量是否已配置(缺失 = 限流静默失效 + 注册无限刷号)
 *   2. service role 是否能真的连通 Supabase 并调用 bump_rate_limit RPC
 *      (配了但值过期/轮换过 = 同样静默失效,这正是 .env.local 曾发生过的事)
 *
 * 用法:
 *   node scripts/check-env.mjs                # 只查必需变量存在性
 *   node scripts/check-env.mjs --live         # 额外做限流 RPC 连通性冒烟
 *
 * 不通过时退出码非 0,可在部署前接入 CI 门禁。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");

// 密钥类变量缺失 = fail-open 生效点。这些是「没配就静默放行」的,
// 与「没配就报错」的普通配置不同 —— 后者用户看得到,前者用户看不到。
const REQUIRED_SECRETS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ENCRYPTION_KEY",
];

// 读 .env.local(开发机)或环境变量(生产)。.env.local 不存在时回退环境变量。
function loadEnv() {
  const dotenvPath = resolve(ROOT, ".env.local");
  if (existsSync(dotenvPath)) {
    const out = {};
    for (const line of readFileSync(dotenvPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return { ...out, ...process.env };
  }
  return process.env;
}

const env = loadEnv();
let failed = false;

console.log("── 密钥类环境变量检查 ──");
for (const key of REQUIRED_SECRETS) {
  const value = env[key];
  const ok = Boolean(value) && value.length > 10;
  if (!ok) {
    failed = true;
    console.error(`  ✗ ${key}:未配置或过短 — fail-open 会让限流/注册保护静默失效`);
  } else {
    console.log(`  ✓ ${key}:已配置(${value.length} 字符)`);
  }
}

// 命名漂移检查:.env.example 曾列 SUPABASE_DB_URL,代码实际读 POSTGRES_URL_NON_POOLING
if (env["SUPABASE_DB_URL"]) {
  console.warn(
    "  ⚠ SUPABASE_DB_URL 已配置但代码不读它 — 代码读取的是 POSTGRES_URL_NON_POOLING,请改名",
  );
}

if (live && !failed) {
  console.log("\n── 限流 RPC 连通性冒烟 ──");
  try {
    const supabaseUrl = env["SUPABASE_URL"];
    const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"];
    if (!supabaseUrl || !serviceKey) {
      console.error("  ✗ 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY,无法冒烟");
      process.exit(1);
    }
    const body = JSON.stringify({
      p_subject: "check-env-smoke",
      p_window_seconds: 3600,
    });
    const resp = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/bump_rate_limit`,
      {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body,
      },
    );
    if (resp.ok) {
      const hits = await resp.json();
      console.log(`  ✓ bump_rate_limit RPC 连通,当前计数 ${hits}`);
      // 冒烟会留下一条计数 —— 顺手清掉,不给限流表留垃圾
      await fetch(
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rate_limits?subject=eq.check-env-smoke`,
        {
          method: "DELETE",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
        },
      );
    } else {
      failed = true;
      console.error(
        `  ✗ bump_rate_limit RPC 返回 ${resp.status} — 密钥可能已轮换或过期,限流将静默失效`,
      );
    }
  } catch (e) {
    failed = true;
    console.error(`  ✗ 限流冒烟失败:${e.message}`);
  }
}

if (failed) {
  console.error(
    "\n结论:部署环境有缺失 — 限流/注册的 fail-open 会让这些缺失在生产上静默失效," +
      "用户在刷号或配额耗尽前不会有任何报错。修好后再上线。",
  );
  process.exit(1);
}
console.log("\n结论:通过。限流与注册的 fail-open 前提已满足(密钥齐备)。");
