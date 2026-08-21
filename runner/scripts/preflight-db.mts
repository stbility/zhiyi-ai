/**
 * Runner E2E 前置验证:PostgreSQL 连接验证(零转换)。
 *
 * 【连接串来源(用户提供,代理不生成)】
 *   - RUNNER_DATABASE_URL:Runner 使用的连接串
 *     (Supabase Shared Pooler Session Mode IPv4,用户从 Dashboard 复制)
 *   - DATABASE_URL:主仓原始数据库配置(保留,不覆盖)
 *   优先级:先 RUNNER_DATABASE_URL,未设置则回退 DATABASE_URL。
 *
 * 【绝对禁止】
 *   - 任何"连接失败 → 自动换连接串"逻辑
 *   - 任何 host/port/username/password/database 替换
 *   - 任何凭据推测或连接地址自动生成
 *   - 输出完整连接串 / 密码 / tenant 敏感信息
 *
 * 【失败处理】只报告真实错误类别与技术原因:
 *   DNS/ENOTFOUND | TIMEOUT | ECONNREFUSED | SSL | AUTH | PERMISSION | QUERY_FAILED
 */

import pg from "pg";

// ── 1. 检查连接串是否存在(优先 RUNNER_DATABASE_URL) ──────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const RUNNER_DATABASE_URL = process.env.RUNNER_DATABASE_URL;
const CONNECTION_STRING = RUNNER_DATABASE_URL ?? DATABASE_URL;
if (!CONNECTION_STRING) {
  console.error("DATABASE_URL / RUNNER_DATABASE_URL = UNSET");
  process.exit(1);
}
const SOURCE = RUNNER_DATABASE_URL ? "RUNNER_DATABASE_URL" : "DATABASE_URL";

// 脱敏 host 显示:只保留主机名与端口,不输出 user/password/完整串
function safeHost(url: string): string {
  try {
    // 用 URL 解析仅提取 hostname/port —— 只读,绝不改写
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return "***";
  }
}

console.log("连接串来源 =", SOURCE);
console.log("DB HOST =", safeHost(CONNECTION_STRING));

// ── 2. 原样建立 pg connection(直接使用连接串,禁止中间转换) ─────────────
const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  max: 2,
  connectionTimeoutMillis: 15_000,
});

async function main(): Promise<void> {
  try {
    // 3. SELECT 1
    const s1 = await pool.query("SELECT 1 AS ok");
    console.log("SELECT 1:", s1.rows[0]?.ok === 1 ? "OK" : "FAIL");

    // 4. 验证 public.agent_runs 可读(只读 count,不输出数据内容)
    const s2 = await pool.query(
      "SELECT count(*)::int AS n FROM public.agent_runs",
    );
    console.log("agent_runs 可读: OK | 行数:", s2.rows[0]?.n);

    // 5. 验证 recover_expired_agent_runs() 是否可调用
    const s3 = await pool.query(
      "SELECT public.recover_expired_agent_runs() AS r",
    );
    console.log("recover_expired_agent_runs(): 可调用 | 返回:", JSON.stringify(s3.rows[0]?.r ?? {}));

    // 6. 当前 DB role / RPC permission 脱敏状态
    const s4 = await pool.query(
      `SELECT current_user AS role,
              has_function_privilege(current_user, 'public.recover_expired_agent_runs()', 'EXECUTE') AS can_execute`,
    );
    console.log("当前角色:", s4.rows[0]?.role, "| RPC EXECUTE:", s4.rows[0]?.can_execute);

    console.log("=== PostgreSQL 前置验证通过 ===");
    await pool.end();
    process.exit(0);
  } catch (err) {
    // 7. 失败:只报告真实错误类别与技术原因,不自动换连接串
    const e = err as { code?: string; message?: string };
    const code = e.code ?? "UNKNOWN";
    const msg = (e.message ?? String(err)).split("\n")[0]?.slice(0, 300) ?? String(err);
    console.error("FAIL(code):", code);
    console.error("FAIL(type):", msg);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

void main();
