import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// mock preflight/admin,避免真实 DB 依赖
vi.mock("@/lib/ai/turn-preflight", () => ({
  preflightTurn: vi.fn(),
  errorResponse: (msg: string, code: number) => new Response(msg, { status: code }),
  quotaExceededResponse: (reason: string) =>
    new Response(JSON.stringify({ error: "quota_exceeded", reason }), { status: 402 }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock("@/lib/billing/turn-quota", () => ({
  checkTurnQuota: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/billing/concurrency", () => ({
  checkConcurrentTasks: vi.fn().mockResolvedValue({ blocked: false }),
}));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/agent/runs/route";
import { preflightTurn } from "@/lib/ai/turn-preflight";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/agent/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
}

describe("POST /api/agent/runs(阶段 G:async 入口)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ASYNC_ENABLED;
  });

  it("feature flag 未开启 → 404(入口不暴露)", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect(preflightTurn).not.toHaveBeenCalled();
  });

  it("flag 开启 + preflight ok → 创建 queued run 返回 runId", async () => {
    process.env.AGENT_ASYNC_ENABLED = "1";
    vi.mocked(preflightTurn).mockResolvedValue({
      ok: true,
      ctx: {
        supabase: {},
        userId: "u-1",
        organizationId: "o-1",
        conversationId: "c-1",
        providerId: "p-1",
        providerKind: "openai-api",
        model: "gpt-oss-120b",
        resumeRunId: null,
        content: "hi",
      },
    } as never);
    vi.mocked(createSupabaseAdminClient).mockReturnValue({
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: { id: "run-123" },
              error: null,
            }),
          }),
        }),
      }),
    } as never);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run-123");
    expect(body.status).toBe("queued");
  });

  it("flag 开启 + preflight 失败 → 返回 preflight 响应", async () => {
    process.env.AGENT_ASYNC_ENABLED = "1";
    vi.mocked(preflightTurn).mockResolvedValue({
      ok: false,
      response: new Response("unauthorized", { status: 401 }),
    } as never);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });
});
