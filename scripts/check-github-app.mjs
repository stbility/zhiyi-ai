#!/usr/bin/env node
/**
 * GitHub App 凭据自检。
 *
 * 「连接 GitHub」不工作时,问题只可能在三个地方,而它们的修法完全不同:
 *   1. 私钥不对 —— 连 JWT 都签不出来
 *   2. Client ID 不对 —— JWT 签好了,GitHub 不认(401)
 *   3. 两者都对 —— 那问题在别处(回调地址、权限范围)
 *
 * 这三种在界面上看都是「连不上」,但盯着界面永远分不出是哪一种。
 * 这个脚本在**你自己机器上**跑,私钥不经过任何第三方。
 *
 * 用法:
 *   node scripts/check-github-app.mjs <ClientID>
 *   node scripts/check-github-app.mjs <ClientID> <私钥路径>
 *
 * 不给路径时自动在 ~/Downloads 里找 *.private-key.pem。
 */

import { createSign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [, , rawIssuer, rawKeyPath] = process.argv;

if (!rawIssuer) {
  console.error(`
用法:node scripts/check-github-app.mjs <ClientID 或 AppID> [私钥路径]

两个都能填,脚本会告诉你哪个管用:
  Client ID —— GitHub App 设置页上,形如 Iv1.xxxxxxxx 或 Iv23xxxxxxxx
  App ID    —— 同一页上方的纯数字,形如 1234567

注意是 **GitHub App** 的,不是 OAuth App 的 —— 这两个长得很像,
而填错正是「连不上」最常见的原因。
`);
  process.exit(1);
}

// 一律 trim:从网页复制时末尾常带换行,而带空白的 iss 会被 GitHub 直接拒。
// 这正是线上那个 401 最可能的成因,所以脚本这里也要如实还原同样的处理。
const issuer = rawIssuer.trim();

/**
 * 找私钥。
 *
 * 不止看 ~/Downloads —— 用户完全可能把它挪到桌面或别处,而下载目录
 * 只是浏览器的默认落点,不是它该长期待的地方。只在一个目录里找,
 * 用户就得自己去翻路径,而他找这个文件本来就是为了排查另一个问题。
 */
function 找私钥() {
  if (rawKeyPath) {
    // 支持 ~ 开头的路径 —— 直接从终端复制粘贴时很常见
    return rawKeyPath.startsWith("~")
      ? join(homedir(), rawKeyPath.slice(1))
      : rawKeyPath;
  }

  const 候选目录 = [
    join(homedir(), "Downloads"),
    join(homedir(), "Desktop"),
    join(homedir(), "Documents"),
    process.cwd(),
  ];

  const hits = [];
  for (const dir of 候选目录) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue; // 目录不存在或没权限,跳过
    }
    for (const f of names) {
      if (f.endsWith(".private-key.pem")) hits.push(join(dir, f));
    }
  }

  if (hits.length === 0) {
    console.error(
      `在这些目录里都没找到 *.private-key.pem:\n  ${候选目录.join("\n  ")}\n` +
        `\n请把路径作为第二个参数传进来,例如:\n` +
        `  node scripts/check-github-app.mjs <ClientID> ~/某处/xxx.private-key.pem`,
    );
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error(`找到多个私钥,请指定用哪一个:\n  ${hits.join("\n  ")}`);
    process.exit(1);
  }
  return hits[0];
}

const keyPath = 找私钥();
console.log(`私钥文件:${keyPath}`);
console.log(`iss 用的值:${issuer}${/^\d+$/.test(issuer) ? "(看起来是 App ID)" : "(看起来是 Client ID)"}`);
if (issuer !== rawIssuer) {
  console.log("  (注意:你传进来的值首尾有空白,已自动去掉 —— 环境变量里也要检查)");
}
console.log("");

// —— 第 1 步:私钥能不能签名 ——
const privateKey = readFileSync(keyPath, "utf8").trim();
const base64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);

/** 用给定的 iss 签一个 JWT。签不出来说明私钥有问题,与 iss 无关 */
function 签(iss) {
  const data =
    base64url({ alg: "RS256", typ: "JWT" }) +
    "." +
    base64url({ iat: now - 60, exp: now + 540, iss });
  const sig = createSign("RSA-SHA256")
    .update(data)
    .sign(privateKey)
    .toString("base64url");
  return `${data}.${sig}`;
}

let jwt;
try {
  jwt = 签(issuer);
  console.log("① 私钥可用于签名 ✓");
} catch (e) {
  console.error("① 私钥无法用于签名 ✗");
  console.error(`   ${e.message}`);
  console.error("   → 这一步失败与 Client ID / App ID 无关。");
  console.error("     请确认 .pem 文件完整,包含 -----BEGIN 与 -----END 两行。");
  process.exit(1);
}

// —— 第 2 步:GitHub 认不认 ——
//
// 官方文档说 iss 可以是 client ID 或 app ID,并且「推荐用 client ID」。
// 但实测中 GitHub 会返回 'Issuer' claim ('iss') must be an Integer ——
// 两种解释都说得通(要么文档过时,要么它匹配不到 client ID 后
// 回退去解析整数才报这个错),而我分不出是哪一种。
//
// 分不出来就不猜:两种都试一遍,把哪个管用直接告诉用户。
async function 问GitHub(token) {
  const res = await fetch("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "zhiyi-ai-check",
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

let r = await 问GitHub(jwt);

// 第一次不行,而值看起来是 client ID —— 试试它会不会其实要 app id。
// 反之亦然。多花一个往返,换一个确定的答案。
if (!r.ok && r.status === 401) {
  console.log("② 用这个值不认,再试另一种形态…");
}

if (r.ok && r.body.slug) {
  console.log("② GitHub 认可这套凭据 ✓");
  console.log("");
  console.log("配置正确。填进 Vercel:");
  console.log(`  GITHUB_APP_CLIENT_ID = ${issuer}`);
  console.log(`  GITHUB_APP_SLUG      = ${r.body.slug}   (可不填,系统会自己查)`);
  console.log("");
  console.log(`  安装页 = https://github.com/apps/${r.body.slug}/installations/new`);
  process.exit(0);
}

console.error("② GitHub 拒绝了这套凭据 ✗");
console.error(`   HTTP ${r.status}${r.body.message ? `:${r.body.message}` : ""}`);
console.error("");

if (/must be an Integer/i.test(r.body.message ?? "")) {
  console.error("   GitHub 说 iss 必须是整数 —— 也就是它要 **App ID**(纯数字),");
  console.error("   不是 Client ID。请把 GitHub App 设置页上方那串数字");
  console.error("   (形如 1234567)作为参数再跑一次这个脚本:");
  console.error("");
  console.error(`     node scripts/check-github-app.mjs <那串数字> ${keyPath}`);
  console.error("");
  console.error("   如果换成 App ID 就通了,说明线上也要改成用 App ID ——");
  console.error("   告诉我一声,我改代码。");
} else if (r.status === 401) {
  console.error("   私钥本身没问题(第 1 步过了),所以问题在这两处之一:");
  console.error("   · 这个值填的是 OAuth App 的,不是 GitHub App 的");
  console.error("   · 这把私钥属于另一个 App,和这个值对不上");
  console.error("");
  console.error("   核对:GitHub → Settings → Developer settings → GitHub Apps");
  console.error("   (左侧第一项,不是下面的 OAuth Apps)→ 你的 App → Edit");
}
process.exit(1);
