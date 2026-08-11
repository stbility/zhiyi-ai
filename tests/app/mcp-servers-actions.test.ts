import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP Server 登记 Server Actions(mcp-servers-actions.ts)。
 *
 * 守的契约:
 *   1. 凭据加密落库,明文只在表单提交瞬间存在
 *   2. 密文列(auth_token_cipher)只走 service_role 取 —— 用户身份客户端
 *      绝不允许 select 它(0030 迁移列级 REVOKE;用户身份查了会 42501,
 *      「测试连接」会永远失败)
 *   3. RLS 拒绝(42501)要说清是权限问题;重名(23505)要说清是重名
 *   4. url 校验:https 强制,http 仅 localhost
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/crypto/secret-box", () => ({
  // base64 编码当"加密":密文里不含明文子串,断言「明文不下发」才有意义
  encryptSecret: vi.fn(
    (v: string) => "cipher:" + Buffer.from(v, "utf8").toString("base64"),
  ),
  maskApiKey: vi.fn((v: string) => "masked:" + v.slice(-4)),
  decryptSecret: vi.fn((v: string) => {
    if (v.startsWith("cipher:")) {
      return Buffer.from(v.slice("cipher:".length), "base64").toString("utf8");
    }
    return "plain-text";
  }),
}));
vi.mock("@/lib/mcp/client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/mcp/client")>();
  return {
    ...orig,
    mcpInitialize: vi.fn(async () => ({ ok: true, message: "连接成功" })),
    // P1-3:testMcpServer 现在在 initialize 后追加 tools/list,
    // 契约测试 mock 掉真实网络调用
    mcpListTools: vi.fn(async () => ({
      ok: true,
      message: "发现 2 个工具",
      tools: [
        { name: "tool_a", description: "工具 A", inputSchema: {} },
        { name: "tool_b", description: "工具 B", inputSchema: {} },
      ],
    })),
  };
});

/** 可变 mock:每个测试设置 supabase 替身与 admin 替身 */
let mockSupabase: ReturnType<typeof fakeSupabase> | null = null;
let mockAdmin: ReturnType<typeof fakeSupabase> | null = null;
let userSelectLog: string[] = [];
let adminSelectLog: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => mockSupabase,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => mockAdmin,
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

/** 与 skills-actions.test.ts 同模式的 Supabase 替身,额外记录 select 的列 */
function fakeSupabase(
  result: {
    count?: number | null;
    error?: { message: string; code?: string } | null;
    data?: unknown;
    insert?: (
      v: Record<string, unknown>,
    ) => { error: { message: string; code?: string } | null };
  },
  selectLog: string[],
) {
  const settled = {
    count: result.count ?? null,
    error: result.error ?? null,
    data: result.data ?? null,
  };
  const chain: Record<string, unknown> = {
    delete: () => chain,
    select: (cols: string) => {
      selectLog.push(cols);
      return chain;
    },
    insert: result.insert ?? (() => ({ error: result.error ?? null })),
    update: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: () => chain,
    then: (resolve: (v: typeof settled) => unknown) => resolve(settled),
  };
  return {
    from: () => chain,
    rpc: async () => ({
      data: [
        { plan_id: "free", feature: "mcp_servers", quota: 1 },
        { plan_id: "free", feature: "knowledge_capacity", quota: 100 },
      ],
      error: null,
    }),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
  };
}

async function load() {
  return import("@/app/(app)/settings/integrations/mcp-servers-actions");
}

function serverForm(): FormData {
  const f = new FormData();
  f.set("organizationId", ORG);
  f.set("name", "github-mcp");
  f.set("url", "https://mcp.example.com");
  f.set("authToken", "secret-token-value");
  f.set("timeoutMs", "15");
  return f;
}

function idForm(): FormData {
  const f = new FormData();
  f.set("id", ID);
  f.set("organizationId", ORG);
  return f;
}

describe("createMcpServer", () => {
  beforeEach(() => {
    userSelectLog = [];
    adminSelectLog = [];
    mockSupabase = fakeSupabase({}, userSelectLog);
    mockAdmin = fakeSupabase({ data: { auth_token_cipher: "cipher:tok" } }, adminSelectLog);
  });

  it("成功登记:令牌加密落库,明文不下发", { timeout: 60_000 }, async () => {
    const inserted: Record<string, unknown>[] = [];
    mockSupabase = fakeSupabase(
      {
        insert: (v) => {
          inserted.push(v);
          return { error: null };
        },
      },
      userSelectLog,
    );
    const { createMcpServer } = await load();
    const out = await createMcpServer({}, serverForm());
    expect(out.error).toBeUndefined();
    expect(out.ok).toContain("github-mcp");
    expect(inserted[0]?.auth_token_cipher).toBe(
      "cipher:" + Buffer.from("secret-token-value", "utf8").toString("base64"),
    );
    expect(inserted[0]?.auth_token_masked).toBe("masked:" + "secret-token-value".slice(-4));
    expect(inserted[0]?.timeout_ms).toBe(15_000);
    expect(JSON.stringify(inserted[0])).not.toContain("secret-token-value");
  });

  it("url 不是 https 且非 localhost → 拒绝", async () => {
    const f = serverForm();
    f.set("url", "http://evil.example.com");
    const { createMcpServer } = await load();
    const out = await createMcpServer({}, f);
    expect(out.error).toContain("https");
  });

  it("RLS 拒绝(42501)→ 说清是权限问题", async () => {
    mockSupabase = fakeSupabase(
      { insert: () => ({ error: { message: "permission denied", code: "42501" } }) },
      userSelectLog,
    );
    const { createMcpServer } = await load();
    const out = await createMcpServer({}, serverForm());
    expect(out.error).toContain("没有权限");
  });

  it("重名(23505)→ 说清是重名", async () => {
    mockSupabase = fakeSupabase(
      {
        insert: () => ({
          error: { message: "duplicate key", code: "23505" },
        }),
      },
      userSelectLog,
    );
    const { createMcpServer } = await load();
    const out = await createMcpServer({}, serverForm());
    expect(out.error).toContain("已存在");
  });
});

describe("testMcpServer", () => {
  beforeEach(() => {
    userSelectLog = [];
    adminSelectLog = [];
    mockSupabase = fakeSupabase(
      { data: { name: "github-mcp", url: "https://mcp.example.com", timeout_ms: 15_000 } },
      userSelectLog,
    );
    mockAdmin = fakeSupabase({ data: { auth_token_cipher: "cipher:tok" } }, adminSelectLog);
  });

  it("契约:用户身份客户端不 select 密文列,密文只走 service_role", async () => {
    const { testMcpServer } = await load();
    const out = await testMcpServer({}, idForm());
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe("连接成功，发现 2 个工具。");
    // 用户身份查询只取可见列 —— 0030 列级 REVOKE 下,select 密文列会 42501
    expect(userSelectLog[0]).toBe("name, url, timeout_ms");
    expect(userSelectLog[0]).not.toContain("auth_token_cipher");
    // 密文由 service_role(admin)客户端取
    expect(adminSelectLog[0]).toContain("auth_token_cipher");
  });

  it("用户身份查不到行 → 找不到或没权限", async () => {
    mockSupabase = fakeSupabase({ data: null }, userSelectLog);
    const { testMcpServer } = await load();
    const out = await testMcpServer({}, idForm());
    expect(out.error).toContain("找不到");
  });

  it("解密失败 → 提示重新登记", async () => {
    const { decryptSecret } = await import("@/lib/crypto/secret-box");
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error("bad cipher");
    });
    const { testMcpServer } = await load();
    const out = await testMcpServer({}, idForm());
    expect(out.error).toContain("解密失败");
  });

  it("连接失败:initialize 返回失败 → 如实回传", async () => {
    const { mcpInitialize } = await import("@/lib/mcp/client");
    vi.mocked(mcpInitialize).mockResolvedValueOnce({
      ok: false,
      message: "server 返回 HTTP 500",
    });
    const { testMcpServer } = await load();
    const out = await testMcpServer({}, idForm());
    expect(out.error).toContain("连接失败");
  });
});

describe("toggleMcpServer / deleteMcpServer", () => {
  beforeEach(() => {
    userSelectLog = [];
    adminSelectLog = [];
    mockSupabase = fakeSupabase(
      { count: 1, data: { enabled: false, name: "github-mcp" } },
      userSelectLog,
    );
    mockAdmin = fakeSupabase({}, adminSelectLog);
  });

  it("启用:count=1 且 enabled 翻转", async () => {
    const { toggleMcpServer } = await load();
    const out = await toggleMcpServer({}, idForm());
    expect(out.ok).toContain("已启用");
  });

  it("count=0 → 没权限或已删除", async () => {
    mockSupabase = fakeSupabase(
      { count: 0, data: { enabled: false, name: "x" } },
      userSelectLog,
    );
    const { toggleMcpServer } = await load();
    const out = await toggleMcpServer({}, idForm());
    expect(out.error).toContain("没有权限");
  });

  it("删除成功", async () => {
    mockSupabase = fakeSupabase({ count: 1, data: null }, userSelectLog);
    const { deleteMcpServer } = await load();
    const out = await deleteMcpServer({}, idForm());
    expect(out.ok).toContain("已删除");
  });
});
