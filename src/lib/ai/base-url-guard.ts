import "server-only";

import { isIP } from "node:net";
import dns from "node:dns/promises";

/**
 * Base URL 的 SSRF 防护。
 *
 * 服务端会用这个 URL 代发请求(chat/completions、messages),而它由
 * 组织的 owner/admin 自填 —— 恶意或被攻破的组织管理员可让服务端向
 * 任意地址发请求。MCP 的 url 有 https/localhost 校验(client.ts
 * validateServerUrl),provider 的 base_url 此前没有任何同等校验。
 *
 * 这里补的是**运行时兜底**:请求发出前解析 DNS 并拒绝私有/环回/链路
 * 本地/元数据网段。之所以放在运行时而不是只放在创建表单:
 *   1. 数据库里可能已存在旧数据(0004 迁移只限了 ^https?:// 前缀)
 *   2. 一个 http(s) URL 可以指向公网域名,解析结果却是内网 IP
 *      (DNS rebinding 的基础形态) —— 只有请求时解析才拦得住
 *
 * 校验是 fail-closed:拿不准(解析失败)就拒绝 —— 服务商域名解析
 * 失败本来就该报错,不该静默发往别处。
 */

/** RFC1918 私有段 + 环回 + 链路本地 + 云元数据 + 文档地址 */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return true; // 解析不出 IP 的当作不可信
  if (v === 6) {
    // IPv6:环回 ::1、链路本地 fe80::/10、唯一本地 fc00::/7、文档 2001:db8::/32
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9")) return true; // fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
    if (lower.startsWith("2001:db8")) return true;
    if (lower.startsWith("::")) return true; // ::/128 未指定
    return false;
  }
  // IPv4
  const octets = ip.split(".").map(Number);
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 环回
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地(云元数据)
  if (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/** 校验一个 base URL 是否可以代发请求。返回 null = 通过,字符串 = 拒绝原因 */
export async function assertSafeBaseUrl(
  rawUrl: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Base URL 不是合法的 URL";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Base URL 只允许 http(s) 协议";
  }

  const rawHostname = parsed.hostname;
  // IPv6 字面量在 URL 里带方括号([::1]、[fe80::1]),isIP 认不得带括号的,
  // 先剥掉再判 —— 否则 IPv6 会掉进 DNS 分支,而 lookup 对 IP 字面量
  // 不做解析,直接失败(fail-closed 倒是安全,但报错文案误导成"无法解析")。
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // 字面 IP:直接判
  if (isIP(hostname) !== 0) {
    return isPrivateIp(hostname)
      ? "Base URL 不允许指向内网或本机地址"
      : null;
  }

  // 主机名:localhost 系列直接拒 —— 它是主机名不是 IP 字面量,
  // 不写这条会掉进 DNS 分支,而生产环境 localhost 指向本机/内网,
  // 正是 SSRF 要拦的对象(测试环境才允许 localhost 的 http)。
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "Base URL 不允许指向本机地址";
  }

  // 域名:解析后判。lookup 默认返回第一个地址;all:true 拿全部,
  // 任何一个命中私有段都拒绝(DNS rebinding 只换一个 A 记录就能绕过)。
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        return `Base URL 的域名(${hostname})解析到内网地址,已拒绝`;
      }
    }
  } catch {
    return `Base URL 的域名(${hostname})无法解析`;
  }

  return null;
}
