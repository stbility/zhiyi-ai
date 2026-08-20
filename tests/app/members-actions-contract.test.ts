import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  inviteMember,
  removeMember,
  updateMemberRole,
} from "@/app/(app)/settings/members/actions";

/**
 * Phase 2 成员管理行为契约测试(P2-01/P2-02/P2-03,2026-08-19)。
 *
 * 守的契约(全部为真实业务语义,非实现细节):
 *   P2-01: organizationId 必须按 z.object 契约传 object —— 曾以 string 传入,
 *          zod 报 "Invalid input: expected object, received string",邀请在生产 100% 失败。
 *   P2-02: owner 保护必须在 Server Action 层成立(不依赖 UI 隐藏按钮):
 *          - owner 不得改自己 role / 删自己
 *          - admin 不得改 owner role / 删 owner
 *          - 非 owner/admin 一律拒绝
 *          - owner/admin 可管理普通成员
 *   P2-03: 重复邀请(23505)与「已是成员」保持现有行为。
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// --- Supabase 替身 ---
interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  [k: string]: unknown;
}

let currentUserId: string;
let adminUserList: { id: string; email: string }[];
let lastInsert: Record<string, unknown> | null;
let insertError: { message: string; code?: string } | null;
let updateError: { message: string; code?: string } | null;
let deleteError: { message: string; code?: string } | null;

function makeSupabase() {
  const q = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: currentUserId, email: "x@x.com" } },
        error: null,
      })),
    },
    from: vi.fn(() => q),
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    in: vi.fn(() => q),
    order: vi.fn(() => q),
    limit: vi.fn(() => q),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    single: vi.fn(async () => ({ data: null, error: null })),
    insert: vi.fn(async (v: Record<string, unknown>) => {
      lastInsert = v;
      return { error: insertError };
    }),
    update: vi.fn(() => {
      const u = {
        eq: vi.fn(async () => ({ error: updateError, data: null })),
      };
      return u;
    }),
    delete: vi.fn(() => {
      const d = {
        eq: vi.fn(async () => ({ error: deleteError, data: null })),
      };
      return d;
    }),
  };
  return q;
}

function makeAdmin() {
  return {
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: adminUserList } })),
      },
    },
  };
}

let supabaseClient: ReturnType<typeof makeSupabase> | null = null;
let adminClient: ReturnType<typeof makeAdmin> | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => supabaseClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => adminClient,
}));

const OWNER = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";
const VIEWER = "00000000-0000-4000-8000-000000000004";
const OUTSIDER = "00000000-0000-4000-8000-000000000005";
const ORG = "11111111-1111-4111-8111-111111111111";

function row(id: string, userId: string, role: string): MembershipRow {
  return { id, organization_id: ORG, user_id: userId, role, status: "active" };
}

const OWNER_ROW = row("a0000000-0000-4000-8000-000000000001", OWNER, "owner");
const ADMIN_ROW = row("a0000000-0000-4000-8000-000000000002", ADMIN, "admin");
const MEMBER_ROW = row("a0000000-0000-4000-8000-000000000003", MEMBER, "member");
const VIEWER_ROW = row("a0000000-0000-4000-8000-000000000004", VIEWER, "viewer");

function formDataWith(orgId: string, email: string, role = "member") {
  const fd = new FormData();
  fd.set("organizationId", orgId);
  fd.set("email", email);
  fd.set("role", role);
  return fd;
}

/** 让 maybeSingle 按「先 org+user 后 id」的查询顺序返回对应行 */
/** 条件感知的 memberships 替身:按 eq("id",...) / eq("user_id",...) 返回匹配行 */
function installMembershipLookup(rows: MembershipRow[]) {
  let eqs: { col: string; val: unknown }[] = [];
  const q = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: currentUserId, email: "x@x.com" } },
        error: null,
      })),
    },
    from: vi.fn(() => q),
    select: vi.fn(() => {
      // 新查询链开始:清空上一轮条件,保证 maybeSingle 只看当前链
      eqs = [];
      return q;
    }),
    eq: vi.fn((col: string, val: unknown) => {
      eqs.push({ col, val });
      return q;
    }),
    in: vi.fn(() => q),
    order: vi.fn(() => q),
    limit: vi.fn(() => q),
    maybeSingle: vi.fn(async () => {
      const idCond = eqs.find((e) => e.col === "id");
      const uidCond = eqs.find((e) => e.col === "user_id");
      let match: MembershipRow | null = null;
      if (idCond) match = rows.find((r) => r.id === idCond.val) ?? null;
      else if (uidCond) match = rows.find((r) => r.user_id === uidCond.val) ?? null;
      return { data: match, error: null };
    }),
    single: vi.fn(async () => ({ data: null, error: null })),
    insert: vi.fn(async (v: Record<string, unknown>) => {
      lastInsert = v;
      return { error: insertError };
    }),
    update: vi.fn(() => {
      const u = {
        eq: vi.fn(async () => ({ error: updateError, data: null })),
      };
      return u;
    }),
    delete: vi.fn(() => {
      const d = {
        eq: vi.fn(async () => ({ error: deleteError, data: null })),
      };
      return d;
    }),
  };
  return q;
}

function resetAll() {
  currentUserId = OWNER;
  adminUserList = [
    { id: MEMBER, email: "member@example.com" },
    { id: ADMIN, email: "admin@example.com" },
  ];
  lastInsert = null;
  insertError = null;
  updateError = null;
  deleteError = null;
}

beforeEach(() => {
  resetAll();
  // 默认替身:memberships 里有 owner 一行(当前用户),admin 有 2 个用户
  supabaseClient = makeSupabase();
  adminClient = makeAdmin();
});

describe("P2-01 邀请输入契约", () => {
  it("organizationId 以 string 传入必须被拒绝且不再出现原生产错误", async () => {
    // 旧代码:orgSchema.safeParse(formData.get("organizationId")) 传 string → zod 报
    // "Invalid input: expected object, received string" —— 修复后该错误不得出现
    const supabase = makeSupabase();
    supabaseClient = supabase;
    const res = await inviteMember(null, formDataWith(ORG, "member@example.com"));
    expect(res.error ?? res.ok ?? "").not.toContain("Invalid input");
    // string 直接作为 object 校验的旧形态不应存在
    const ACTIONS = (await import("node:fs")).readFileSync(
      require.resolve("../../src/app/(app)/settings/members/actions.ts"),
      "utf8",
    );
    expect(ACTIONS).not.toMatch(/safeParse\(formData\.get\("organizationId"\)\)/);
    expect(ACTIONS).toMatch(/safeParse\(\{\s*\n\s*organizationId: formData\.get\("organizationId"\)/);
  });
});

describe("P2-02 Owner/Admin 保护(Server Action 层)", () => {
  it("owner 修改自己 role → 拒绝(组织不能失去唯一 owner)", async () => {
    const client = makeSupabase();
    supabaseClient = client;
    // 操作者=owner,目标=owner 自己
    supabaseClient = installMembershipLookup([OWNER_ROW, OWNER_ROW]);
    const res = await updateMemberRole(OWNER_ROW.id, "member");
    expect(res.error).toContain("所有者角色不可修改");
  });

  it("owner 删除自己 → 拒绝", async () => {
    supabaseClient = installMembershipLookup([OWNER_ROW, OWNER_ROW]);
    const res = await removeMember(OWNER_ROW.id);
    expect(res.error).toContain("所有者成员不可移除");
  });

  it("admin 修改 owner role → 拒绝", async () => {
    currentUserId = ADMIN;
    supabaseClient = installMembershipLookup([ADMIN_ROW, OWNER_ROW]);
    const res = await updateMemberRole(OWNER_ROW.id, "member");
    expect(res.error).toContain("所有者角色不可修改");
  });

  it("admin 删除 owner → 拒绝", async () => {
    currentUserId = ADMIN;
    supabaseClient = installMembershipLookup([ADMIN_ROW, OWNER_ROW]);
    const res = await removeMember(OWNER_ROW.id);
    expect(res.error).toContain("所有者成员不可移除");
  });

  it("member 修改角色 → 拒绝", async () => {
    currentUserId = MEMBER;
    supabaseClient = installMembershipLookup([MEMBER_ROW, MEMBER_ROW]);
    const res = await updateMemberRole(MEMBER_ROW.id, "admin");
    expect(res.error).toContain("只有组织所有者或管理员可以修改角色");
  });

  it("member 删除成员 → 拒绝", async () => {
    currentUserId = MEMBER;
    supabaseClient = installMembershipLookup([MEMBER_ROW, MEMBER_ROW]);
    const res = await removeMember(MEMBER_ROW.id);
    expect(res.error).toContain("只有组织所有者或管理员可以移除成员");
  });

  it("viewer 修改角色 → 拒绝", async () => {
    currentUserId = VIEWER;
    supabaseClient = installMembershipLookup([VIEWER_ROW, MEMBER_ROW]);
    const res = await updateMemberRole(MEMBER_ROW.id, "admin");
    expect(res.error).toContain("只有组织所有者或管理员可以修改角色");
  });

  it("viewer 删除成员 → 拒绝", async () => {
    currentUserId = VIEWER;
    supabaseClient = installMembershipLookup([VIEWER_ROW, MEMBER_ROW]);
    const res = await removeMember(MEMBER_ROW.id);
    expect(res.error).toContain("只有组织所有者或管理员可以移除成员");
  });

  it("非成员操作 → 拒绝", async () => {
    currentUserId = OUTSIDER;
    // 操作者查询返回 null(非成员)
    supabaseClient = installMembershipLookup([MEMBER_ROW, MEMBER_ROW]);
    const res = await updateMemberRole(MEMBER_ROW.id, "admin");
    expect(res.error).toContain("只有组织所有者或管理员可以修改角色");
  });

  it("owner 修改普通 member 角色 → 允许", async () => {
    supabaseClient = installMembershipLookup([OWNER_ROW, MEMBER_ROW]);
    const res = await updateMemberRole(MEMBER_ROW.id, "admin");
    expect(res.ok).toBe("角色已更新。");
  });

  it("owner 删除普通 member → 允许", async () => {
    supabaseClient = installMembershipLookup([OWNER_ROW, MEMBER_ROW]);
    const res = await removeMember(MEMBER_ROW.id);
    expect(res.ok).toBe("成员已移除。");
  });

  it("admin 修改普通 member role → 允许", async () => {
    currentUserId = ADMIN;
    supabaseClient = installMembershipLookup([ADMIN_ROW, MEMBER_ROW]);
    const res = await updateMemberRole(MEMBER_ROW.id, "member");
    expect(res.ok).toBe("角色已更新。");
  });

  it("admin 删除普通 member → 允许", async () => {
    currentUserId = ADMIN;
    supabaseClient = installMembershipLookup([ADMIN_ROW, MEMBER_ROW]);
    const res = await removeMember(MEMBER_ROW.id);
    expect(res.ok).toBe("成员已移除。");
  });
});

describe("P2-01 邀请行为契约", () => {
  it("owner 邀请已注册用户 → 成功,membership 写入 active", async () => {
    const client = makeSupabase();
    supabaseClient = client;
    adminClient = makeAdmin();
    // 操作者查询返回 owner
    supabaseClient = installMembershipLookup([OWNER_ROW]);
    const res = await inviteMember(null, formDataWith(ORG, "member@example.com"));
    expect(res.ok).toContain("已邀请");
    expect(lastInsert).toMatchObject({
      organization_id: ORG,
      user_id: MEMBER,
      role: "member",
      status: "active",
    });
  });

  it("owner 邀请未注册用户 → 现有正确错误", async () => {
    supabaseClient = installMembershipLookup([OWNER_ROW]);
    adminUserList = [];
    const res = await inviteMember(null, formDataWith(ORG, "ghost@nowhere.com"));
    expect(res.error).toContain("该邮箱尚未注册智一 AI");
  });

  it("member 邀请 → 拒绝", async () => {
    currentUserId = MEMBER;
    // 操作者身份查询返回 member
    supabaseClient = installMembershipLookup([MEMBER_ROW]);
    const res = await inviteMember(null, formDataWith(ORG, "member@example.com"));
    expect(res.error).toContain("只有组织所有者或管理员可以邀请成员");
  });

  it("viewer 邀请 → 拒绝", async () => {
    currentUserId = VIEWER;
    supabaseClient = installMembershipLookup([VIEWER_ROW]);
    const res = await inviteMember(null, formDataWith(ORG, "member@example.com"));
    expect(res.error).toContain("只有组织所有者或管理员可以邀请成员");
  });

  it("重复邀请(23505)→ 保持现有错误文案", async () => {
    supabaseClient = installMembershipLookup([OWNER_ROW]);
    insertError = { message: "duplicate key", code: "23505" };
    const res = await inviteMember(null, formDataWith(ORG, "member@example.com"));
    expect(res.error).toContain("该用户已是组织成员");
  });

  it("邀请对象已是成员且邮箱不匹配任何 auth 用户 → 未注册错误", async () => {
    supabaseClient = installMembershipLookup([OWNER_ROW]);
    adminUserList = [];
    const res = await inviteMember(null, formDataWith(ORG, "already@example.com"));
    expect(res.error).toContain("尚未注册");
  });
});

describe("P2-02 参数契约", () => {
  it("memberId 非 UUID → 拒绝", async () => {
    const res = await updateMemberRole("not-a-uuid", "member");
    expect(res.error).toContain("成员标识无效");
  });

  it("role 非 member/admin → 拒绝", async () => {
    const res = await updateMemberRole(MEMBER_ROW.id, "owner" as never);
    expect(res.error).toContain("角色不合法");
  });
});
