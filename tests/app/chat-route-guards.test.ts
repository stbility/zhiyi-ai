import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 聊天路由的准入判断。
 *
 * route.ts 有 600 多行,是整个系统的心脏,此前**零测试覆盖** ——
 * 外部审查里的第 7 条(用量归属可能记到错误的组织、写库失败全静默)
 * 正好落在这片盲区里。
 *
 * 这里覆盖的是「在调用模型之前就该拦下来」的几种情况。这些分支尤其重要:
 * 一旦漏放,代价是**真金白银**(模型照常被调用)加上**数据错乱**
 * (消息带着 B 组织的归属落进 A 组织的对话,而 messages 是计费的唯一依据)。
 */

vi.mock("server-only", () => ({}));

const state = {
  user: { id: "u1" } as { id: string } | null,
  provider: null as Record<string, unknown> | null,
  conversation: null as Record<string, unknown> | null,
  rateLimited: false,
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      const row =
        table === "ai_providers"
          ? state.provider
          : table === "conversations"
            ? state.conversation
            : null;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: () => chain,
        upsert: () => chain,
        update: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
        single: async () => ({ data: row, error: null }),
        then: (r: (v: unknown) => unknown) =>
          r({ data: row ? [row] : [], error: null, count: 1 }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/services/rate-limit", () => ({
  CHAT_LIMITS: [],
  REGISTER_LIMITS: [],
  checkRateLimit: async () => ({
    allowed: !state.rateLimited,
    reason: state.rateLimited ? "请求过于频繁" : null,
  }),
}));

/** 密文永远不该从用户身份客户端读到 —— 这里替身直接给一个假密文 */
vi.mock("@/lib/ai/credentials", () => ({
  loadProviderCipher: async () => "cipher",
  loadIntegrationCipher: async () => "cipher",
}));

/**
 * 造一个 NextRequest。
 *
 * 路由签名要的是 NextRequest 而不是 Request —— 它多了 cookies / nextUrl。
 * 用 new NextRequest 而不是把 Request 强转:强转能骗过类型检查,
 * 但真跑起来路由访问 request.nextUrl 时会炸,那样的测试等于没测。
 */
function post(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROVIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

beforeEach(() => {
  vi.resetModules();
  state.user = { id: "u1" };
  state.provider = {
    id: PROVIDER,
    kind: "openai_compatible",
    base_url: "https://x.test/v1",
    organization_id: ORG_A,
    enabled: true,
  };
  state.conversation = { id: CONV, organization_id: ORG_A };
  state.rateLimited = false;
});

describe("聊天路由准入", () => {
  it("未登录一律拒绝", async () => {
    state.user = null;
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      post({ providerId: PROVIDER, model: "m", content: "你好" }),
    );
    expect(res.status).toBe(401);
  });

  it("跨组织的对话 id 被拒绝 —— 否则计费归属会被污染", async () => {
    // 对话属于 B 组织,而选用的服务商属于 A 组织
    state.conversation = { id: CONV, organization_id: ORG_B };
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      post({
        providerId: PROVIDER,
        model: "m",
        content: "你好",
        conversationId: CONV,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("同一个组织");
  });

  it("对话不存在时拒绝,而不是新建一个", async () => {
    state.conversation = null;
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      post({
        providerId: PROVIDER,
        model: "m",
        content: "你好",
        conversationId: CONV,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("停用的服务商不可调用", async () => {
    state.provider = { ...state.provider!, enabled: false };
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      post({ providerId: PROVIDER, model: "m", content: "你好" }),
    );
    expect(res.status).toBe(400);
  });

  it("找不到服务商时拒绝", async () => {
    state.provider = null;
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      post({ providerId: PROVIDER, model: "m", content: "你好" }),
    );
    expect(res.status).toBe(404);
  });

  it("超限时在调用模型之前就拦下", async () => {
    state.rateLimited = true;
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      post({ providerId: PROVIDER, model: "m", content: "你好" }),
    );
    expect(res.status).toBe(429);
  });

  it("请求体不合法时拒绝", async () => {
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(post({ providerId: "不是 uuid", content: "" }));
    expect(res.status).toBe(400);
  });
});
