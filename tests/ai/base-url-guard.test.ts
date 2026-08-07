import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertSafeBaseUrl,
} from "@/lib/ai/base-url-guard";

/**
 * Base URL SSRF 防护(修复 Bug 6)。
 *
 * 服务端会用 base_url 代发请求,而它由组织 owner/admin 自填 ——
 * 必须拒绝内网/环回/链路本地/云元数据地址。判定在请求前做:
 * 字面 IP 直接判,域名解析后逐地址判(DNS rebinding 只需一个 A 记录)。
 */

describe("assertSafeBaseUrl 协议校验", () => {
  it("拒绝非 http(s) 协议", async () => {
    expect(await assertSafeBaseUrl("ftp://example.com")).toMatch(/只允许 http\(s\)/);
    expect(await assertSafeBaseUrl("file:///etc/passwd")).toMatch(/只允许 http\(s\)/);
    expect(await assertSafeBaseUrl("javascript:alert(1)")).toMatch(/只允许 http\(s\)/);
  });

  it("拒绝不是合法 URL 的输入", async () => {
    expect(await assertSafeBaseUrl("not a url at all")).toMatch(/不是合法的 URL/);
    expect(await assertSafeBaseUrl("")).toMatch(/不是合法的 URL/);
  });
});

describe("assertSafeBaseUrl 字面 IP 判定", () => {
  it("拒绝环回地址", async () => {
    expect(await assertSafeBaseUrl("http://127.0.0.1:8080")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("http://localhost:11434")).toMatch(/内网|本机/);
  });

  it("拒绝云元数据端点", async () => {
    expect(await assertSafeBaseUrl("http://169.254.169.254/latest/meta-data")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("https://169.254.169.254")).toMatch(/内网|本机/);
  });

  it("拒绝 RFC1918 私有段", async () => {
    expect(await assertSafeBaseUrl("http://10.0.0.1")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("http://172.16.0.1")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("http://172.31.255.254")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("http://192.168.1.1")).toMatch(/内网|本机/);
  });

  it("放行公网字面 IP(没有内网特征时)", async () => {
    // 8.8.8.8 是公网 DNS,应当放行
    expect(await assertSafeBaseUrl("https://8.8.8.8")).toBeNull();
  });
});

describe("assertSafeBaseUrl 域名解析", () => {
  it("放行公网域名(官方服务商)", async () => {
    expect(await assertSafeBaseUrl("https://api.openai.com/v1")).toBeNull();
    expect(await assertSafeBaseUrl("https://api.anthropic.com")).toBeNull();
  });

  it("解析失败时拒绝(fail-closed)", async () => {
    // 不存在且无法解析的域名
    const result = await assertSafeBaseUrl(
      "https://this-host-does-not-exist-xyz-12345.invalid",
    );
    expect(result).toMatch(/无法解析/);
  });
});

describe("assertSafeBaseUrl IPv6", () => {
  it("拒绝 IPv6 环回与链路本地", async () => {
    expect(await assertSafeBaseUrl("http://[::1]:8080")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("http://[fe80::1]")).toMatch(/内网|本机/);
  });

  it("拒绝 IPv6 唯一本地地址", async () => {
    expect(await assertSafeBaseUrl("http://[fd00::1]")).toMatch(/内网|本机/);
    expect(await assertSafeBaseUrl("http://[fc00::1]")).toMatch(/内网|本机/);
  });

  it("拒绝 IPv6 文档地址", async () => {
    expect(await assertSafeBaseUrl("http://[2001:db8::1]")).toMatch(/内网|本机/);
  });
});
