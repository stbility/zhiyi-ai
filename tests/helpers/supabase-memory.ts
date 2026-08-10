/**
 * 内存版 Supabase admin 客户端 —— 给「真正执行路由代码」的测试用。
 *
 * 为什么不用「返回固定行」的哑替身:支付路由的正确性恰恰在**写入之后的状态**
 * 上(乱序事件谁覆盖谁、upsert 会不会建出第二行、update 命中了几行)。
 * 哑替身能让断言通过却证明不了这些,所以这里维护真实的行集合,
 * upsert 按 onConflict 键去重,update 返回实际命中的行。
 *
 * 只实现路由真正用到的调用形态。遇到没实现的表会**抛错**而不是静默返回空 ——
 * 静默空值会让测试假绿。
 */

export type Row = Record<string, unknown>;

export interface MemoryDb {
  subscriptions: Row[];
  stripe_customers: Row[];
  users: { id: string; email: string }[];
}

export function createMemoryDb(): MemoryDb {
  return { subscriptions: [], stripe_customers: [], users: [] };
}

function tableOf(db: MemoryDb, name: string): Row[] {
  const t = (db as unknown as Record<string, Row[]>)[name];
  if (!t) throw new Error(`测试替身未实现表 ${name}`);
  return t;
}

function makeBuilder(db: MemoryDb, table: string) {
  let op: "select" | "update" | "upsert" = "select";
  let values: Row = {};
  let conflictKey = "id";
  const filters: [string, unknown][] = [];

  const matches = (r: Row) => filters.every(([c, v]) => r[c] === v);

  const exec = (): { data: Row[] | null; error: null } => {
    const rows = tableOf(db, table);
    if (op === "upsert") {
      const key = values[conflictKey];
      const existing = rows.find((r) => r[conflictKey] === key);
      if (existing) Object.assign(existing, values);
      else rows.push({ ...values });
      return { data: null, error: null };
    }
    const hit = rows.filter(matches);
    if (op === "update") hit.forEach((r) => Object.assign(r, values));
    return { data: hit.map((r) => ({ ...r })), error: null };
  };

  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => {
      filters.push([c, v]);
      return b;
    },
    update: (v: Row) => {
      op = "update";
      values = v;
      return b;
    },
    upsert: (v: Row, opts?: { onConflict?: string }) => {
      op = "upsert";
      values = v;
      conflictKey = opts?.onConflict ?? "id";
      return b;
    },
    maybeSingle: async () => {
      const r = exec();
      return { data: r.data?.[0] ?? null, error: null };
    },
    // thenable:让 `await from(...).upsert(...)` 这种不带终结符的链能直接 await
    then: (resolve: (v: { data: Row[] | null; error: null }) => unknown) =>
      resolve(exec()),
  };
  return b;
}

/** 造一个够用的 admin 客户端替身 */
export function createMemoryAdminClient(db: MemoryDb) {
  return {
    from: (table: string) => makeBuilder(db, table),
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number; perPage: number }) => ({
          data: { users: page === 1 ? db.users : [] },
        }),
      },
    },
  };
}
