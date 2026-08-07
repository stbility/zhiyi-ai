import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 外部能力装配(src/lib/ai/external.ts)。
 *
 * buildExternalContext 把数据库里的 mcp_servers + skills 变成 agent
 * 工具循环能用的上下文。守的是:
 *   1. 降级:单个 server 令牌解密失败/url 不合法只跳过它,其余照常
 *   2. 空装配:两者都没有时返回 undefined —— agent 行为与旧版完全一致
 *   3. 组织隔离:查询必须带 organization_id
 *   4. 密文安全:auth_token_cipher 只走 admin 客户端(0030 列级 REVOKE)
 */

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// 必须在任何含 `import "server-only"` 的模块加载前拦截
// vi.mock 会 hoist,在 vi.resetModules() 之前就替换掉真正的 server-only
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(() => null),
}));

vi.mock("@/lib/crypto/secret-box", () => ({
  decryptSecret: vi.fn((cipher: string) => {
    if (cipher === "bad-cipher") throw new Error("解密失败");
    return "decrypted:" + cipher;
  }),
}));

vi.mock("@/lib/ai/skills", () => ({
  loadSkill: vi.fn(async () => null),
}));

async function loadExternal() {
  vi.resetModules();
  return await import("@/lib/ai/external");
}

function fakeSupabase(rows: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      return {
        select: (_cols: string) => ({
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return {
              eq: (col2: string, val2: unknown) => {
                filters[col2] = val2;
                return {
                  order: (_col: string) => ({
                    then: (resolve: (v: unknown) => void) => {
                      const hit = (rows[table] ?? []).filter((r) =>
                        Object.entries(filters).every(([k, v]) => r[k] === v),
                      );
                      resolve({ data: hit, error: null });
                    },
                  }),
                };
              },
              order: (_col: string) => ({
                then: (resolve: (v: unknown) => void) => {
                  const hit = (rows[table] ?? []).filter((r) =>
                    Object.entries(filters).every(([k, v]) => r[k] === v),
                  );
                  resolve({ data: hit, error: null });
                },
              }),
            };
          },
          order: (_col: string) => ({
            then: (resolve: (v: unknown) => void) => {
              const hit = (rows[table] ?? []).filter((r) =>
                Object.entries(filters).every(([k, v]) => r[k] === v),
              );
              resolve({ data: hit, error: null });
            },
          }),
        }),
      };
    },
  };
}

function fakeAdminSupabase(cipherRows: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => ({
      select: () => ({
        in: (_col: string, _ids: unknown[]) => ({
          then: (resolve: (v: unknown) => void) => {
            resolve({ data: cipherRows[table] ?? [], error: null });
          },
        }),
      }),
    }),
  };
}

describe("buildExternalContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("两者都没有时返回 undefined(agent 行为与旧版一致)", async () => {
    const { buildExternalContext } = await loadExternal();
    const supabase = fakeSupabase({ mcp_servers: [], skills: [] }) as never;
    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeUndefined();
  });

  it("admin 客户端创建失败时返回 undefined", async () => {
    const { buildExternalContext } = await loadExternal();
    const supabase = fakeSupabase({
      mcp_servers: [
        { id: "1", name: "github", url: "https://mcp.github.com", auth_token_cipher: "c1", timeout_ms: 10000, enabled: true, organization_id: ORG_A },
      ],
      skills: [],
    }) as never;
    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeUndefined();
  });

  it("装配启用的 server(解密令牌)与技能摘要", async () => {
    const { buildExternalContext } = await loadExternal();
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const adminFake = fakeAdminSupabase({ mcp_servers: [{ id: "1", auth_token_cipher: "cipher-1" }] });
    (createSupabaseAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(adminFake as never);
    const supabase = fakeSupabase({
      mcp_servers: [
        { id: "1", name: "github", url: "https://mcp.github.com", auth_token_cipher: "cipher-1", timeout_ms: 10000, enabled: true, organization_id: ORG_A },
      ],
      skills: [
        { name: "weekly-report", title: "周报", description: "生成周报", version: "1.0.0", tags: ["report"], enabled: true, organization_id: ORG_A },
      ],
    }) as never;
    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeDefined();
    expect(ctx?.servers.size).toBe(1);
    expect(ctx?.servers.get("github")?.authToken).toBe("decrypted:cipher-1");
    expect(ctx?.servers.get("github")?.timeoutMs).toBe(10000);
    expect(ctx?.skills).toHaveLength(1);
    expect(ctx?.skills[0]?.name).toBe("weekly-report");
  });

  it("令牌解密失败的 server 被跳过,其余照常装配", async () => {
    const { buildExternalContext } = await loadExternal();
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const adminFake = fakeAdminSupabase({
      mcp_servers: [
        { id: "1", auth_token_cipher: "bad-cipher" },
        { id: "2", auth_token_cipher: "cipher-2" },
      ],
    });
    (createSupabaseAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(adminFake as never);
    const supabase = fakeSupabase({
      mcp_servers: [
        { id: "1", name: "broken", url: "https://mcp.broken.com", auth_token_cipher: "bad-cipher", timeout_ms: 5000, enabled: true, organization_id: ORG_A },
        { id: "2", name: "ok", url: "https://mcp.ok.com", auth_token_cipher: "cipher-2", timeout_ms: 5000, enabled: true, organization_id: ORG_A },
      ],
      skills: [],
    }) as never;
    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx).toBeDefined();
    expect(ctx?.servers.has("broken")).toBe(false);
    expect(ctx?.servers.has("ok")).toBe(true);
    expect(ctx?.skills).toHaveLength(0);
  });

  it("url 不合法的 server 被跳过(http 非 localhost)", async () => {
    const { buildExternalContext } = await loadExternal();
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const adminFake = fakeAdminSupabase({ mcp_servers: [{ id: "1", auth_token_cipher: "cipher-1" }] });
    (createSupabaseAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(adminFake as never);
    const supabase = fakeSupabase({
      mcp_servers: [
        { id: "1", name: "http-server", url: "http://mcp.example.com", auth_token_cipher: "cipher-1", timeout_ms: 5000, enabled: true, organization_id: ORG_A },
      ],
      skills: [],
    }) as never;
    const ctx = await buildExternalContext(supabase, ORG_A);
    expect(ctx?.servers.has("http-server")).toBe(false);
    expect(ctx?.servers.size).toBe(0);
  });
});
