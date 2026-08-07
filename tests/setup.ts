import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

/**
 * 全局测试环境替身。
 *
 * node:dns/promises —— SSRF 守卫(base-url-guard.ts)在请求前解析
 * base_url 的域名并拒绝内网地址。测试用 api.example.com 这类假域名,
 * 真实 DNS 解析不了,守卫会 fail-closed 拒绝 → 既有网关测试全挂。
 *
 * 这里把 lookup 换成确定性替身:
 *   · .invalid 后缀(守卫测试显式验证"解析失败 → 拒绝"分支)抛错
 *   · 其余一律返回一个公网 IP —— 守卫判定「公网,放行」,
 *     网关测试得以正常打假 fetch
 *
 * 判定逻辑与 base-url-guard 的 fail-closed 语义保持一致:
 * 解析不了 = 拒绝,解析到公网 = 放行。
 */
vi.mock("node:dns/promises", () => ({
  default: {
    lookup: async (hostname: string) => {
      if (hostname.endsWith(".invalid")) {
        const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        (err as NodeJS.ErrnoException).code = "ENOTFOUND";
        throw err;
      }
      // 93.184.216.34 是 example.com 的真实公网地址 —— 公网段,守卫放行
      return [{ address: "93.184.216.34", family: 4 }];
    },
  },
}));
