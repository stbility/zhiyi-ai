import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// mock 鉴权/服务端客户端,避免真实 DB 依赖
vi.mock("@/lib/ai/turn-preflight", () => ({
  errorResponse: (msg: string, code: number) =>
    new Response(JSON.stringify({ error: msg }), { status: code }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { GET } from "@/app/api/agent/runs/[id]/route";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 模拟 supabase 客户端链式查询。行为由脚本化查询表驱动:
 *   agent_runs 查询 → 返回 A 用户的 run
 *   agent_steps 查询 → 返回步骤
 * 越权场景:auth.getUser 返回 B 用户,但 RLS 使 agent_runs 查无此行(模拟 RLS 拒绝)。
 */
function makeSupabaseMock(overrides: {
  user?: { id: string } | null;
  runRow?: Record<string, unknown> | null;
} = {}) {
  const {
    user = { id: "user-A" },
    runRow = {
      id: "11111111-1111-1111-1111-111111111111",
      status: "running",
      current_step: 2,
      error_message: null,
      resumable: false,
      model_id: "openai/gpt-oss-20b",
      task_type: "agent",
      started_at: "2026-08-24T00:00:00Z",
      updated_at: "2026-08-24T00:01:00Z",
      completed_at: null,
    },
  } = overrides;

  const queries: { table: string; method: string; eq: unknown[] }[] = [];

  const chain = (table: string) => {
    let q: { eq?: unknown[] } = {};
    const builder = {
      select: () => {
        queries.push({ table, method: "select", eq: q.eq ?? ([] as unknown[]) });
        return builder;
      },
      eq: (col: string, val: unknown) => {
        q = { eq: [col, val] };
        return builder;
      },
      order: () => builder,
      maybeSingle: async () => {
        // RLS 语义:agent_runs 只返回「当前用户可见」的行。
        // user-A 看到 runRow;user-B(越权)看到 null(RLS 拒绝 → 404)。
        if (table === "agent_runs") {
          return { data: user?.id === "user-A" ? runRow : null, error: null };
        }
        return { data: null, error: null };
      },
    };
    return builder;
  };

  // agent_steps 查询(.select().eq().order() 链式,整体可 await → { data, error })
  const stepsRows = [
    {
      step_index: 100,
      tool_name: "write_file",
      ok: true,
      result_preview: "已写入 report.md",
      started_at: "2026-08-24T00:00:30Z",
      completed_at: "2026-08-24T00:00:31Z",
    },
  ];
  const stepsChain = () => {
    const q = {
      select: () => {
        queries.push({ table: "agent_steps", method: "select", eq: [] });
        return q;
      },
      eq: (col: string, val: unknown) => {
        // 保留最后一次 eq 记录
        queries.push({ table: "agent_steps", method: "select", eq: [col, val] });
        return q;
      },
      order: () => q,
      then: (
        resolve: (v: { data: unknown; error: null }) => void,
      ): void => {
        resolve({ data: user?.id === "user-A" ? stepsRows : [], error: null });
      },
    };
    return q;
  };

  return {
    mock: {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      },
      from: vi.fn((table: string) =>
        table === "agent_steps" ? stepsChain() : chain(table),
      ),
    } as never,
    queries,
  };
}

function makeRequest(runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/agent/runs/${runId}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

describe("GET /api/agent/runs/[id](阶段 G 补充:状态查询,只读)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未登录 → 401", async () => {
    const { mock } = makeSupabaseMock({ user: null });
    vi.mocked(createSupabaseServerClient).mockReturnValue(mock);
    const res = await GET(
      makeRequest("11111111-1111-1111-1111-111111111111"),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(res.status).toBe(401);
  });

  it("runId 非 UUID → 400", async () => {
    const { mock } = makeSupabaseMock();
    vi.mocked(createSupabaseServerClient).mockReturnValue(mock);
    const res = await GET(makeRequest("not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("本人 run → 200,返回状态/步骤/字段齐全", async () => {
    const { mock, queries } = makeSupabaseMock();
    vi.mocked(createSupabaseServerClient).mockReturnValue(mock);
    const res = await GET(
      makeRequest("11111111-1111-1111-1111-111111111111"),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.status).toBe("running");
    expect(body.currentStep).toBe(2);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].tool).toBe("write_file");
    expect(body.steps[0].ok).toBe(true);
    // 查询按 run_id 过滤(防查错行)
    const stepsQuery = queries.find(
      (q) =>
        q.table === "agent_steps" &&
        q.eq.length === 2 &&
        q.eq[0] === "run_id",
    );
    expect(stepsQuery?.eq).toEqual([
      "run_id",
      "11111111-1111-1111-1111-111111111111",
    ]);
  });

  it("【多租户越权】B 用户读 A 用户的 run → 404(RLS 拒绝,不泄露存在)", async () => {
    // B 用户登录,但 RLS(agent_runs_own)只放行本人行 → 查无此行
    const { mock } = makeSupabaseMock({
      user: { id: "user-B" },
      runRow: {
        id: "11111111-1111-1111-1111-111111111111",
        status: "running",
        current_step: 0,
        error_message: null,
        resumable: false,
        model_id: "openai/gpt-oss-20b",
        task_type: "agent",
        started_at: "2026-08-24T00:00:00Z",
        updated_at: "2026-08-24T00:01:00Z",
        completed_at: null,
      },
    });
    vi.mocked(createSupabaseServerClient).mockReturnValue(mock);
    const res = await GET(
      makeRequest("11111111-1111-1111-1111-111111111111"),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    // 越权必须 404 —— 与「不存在」同响应,防 run 存在性枚举
    expect(res.status).toBe(404);
  });

  it("【多租户越权】B 用户读 A 用户步骤 → 不返回任何 steps 数据", async () => {
    const { mock } = makeSupabaseMock({
      user: { id: "user-B" },
    });
    vi.mocked(createSupabaseServerClient).mockReturnValue(mock);
    const res = await GET(
      makeRequest("11111111-1111-1111-1111-111111111111"),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(res.status).toBe(404);
  });
});
