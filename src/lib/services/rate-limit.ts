import "server-only";

import { logger } from "@/lib/log";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * 调用频率限制。
 *
 * 为什么必须有:/api/chat 此前只校验登录,一个循环脚本就能把用户配置的
 * 服务商配额刷干,而账单落在用户头上。这是整个系统里唯一会造成**直接
 * 金钱损失**的缺口,优先级高于任何功能。
 *
 * 为什么放在数据库:Vercel 的函数是多实例的,进程内计数各算各的,等于没限。
 * 数据库是唯一的共享事实来源(见迁移 0013 的 private.bump_rate_limit)。
 *
 * 计数用 service role 写 —— 用户身份客户端若能改计数,限流就形同虚设。
 */

export interface RateLimitRule {
  /** 窗口长度(秒) */
  readonly windowSeconds: number;
  /** 窗口内允许的次数 */
  readonly max: number;
  /** 超限时给用户看的说明 */
  readonly label: string;
}

/**
 * 对话调用的限额。
 *
 * 两层窗口:短窗挡住失控的循环,长窗挡住持续刷量。
 * 数值取得比正常人的使用强度高一截 —— 限流是为了防跑飞的脚本,
 * 不是为了管束正常使用。真人一分钟发不出 20 条,而脚本一秒就能发 20 条。
 */
export const CHAT_LIMITS: readonly RateLimitRule[] = [
  { windowSeconds: 60, max: 20, label: "每分钟最多 20 次" },
  { windowSeconds: 3600, max: 300, label: "每小时最多 300 次" },
];

/**
 * 注册的限额。
 *
 * 注册走的是 admin.auth.admin.createUser(service role 建号),
 * 这条路径**绕过了 Supabase 自身的注册限流** —— 而产品又明确不要邮箱验证,
 * 于是没有任何东西挡在前面:一个脚本可以无限刷号,把 auth.users 撑爆,
 * 也会把每个新号自动建的组织与审计记录一起灌进来。
 *
 * 不验证邮箱是产品方明示的取舍,可以接受;无限流叠加 service-role 绕过
 * 是另一回事。这里按来源 IP 限,数值比真人注册强度高一截。
 */
export const REGISTER_LIMITS: readonly RateLimitRule[] = [
  { windowSeconds: 600, max: 5, label: "每 10 分钟最多 5 次注册" },
  { windowSeconds: 86_400, max: 20, label: "每天最多 20 次注册" },
];

export interface RateLimitResult {
  readonly allowed: boolean;
  /** 被拒绝时的说明,可直接展示给用户 */
  readonly reason: string | null;
}

/**
 * 记一次调用并判断是否超限。
 *
 * 未配置 service role 时返回放行 —— 限流不该成为「整个功能不可用」的原因,
 * 但这属于配置缺失,应当在部署检查里发现。
 */
export async function checkRateLimit(
  subject: string,
  rules: readonly RateLimitRule[] = CHAT_LIMITS,
): Promise<RateLimitResult> {
  const admin = createSupabaseAdminClient();
  if (!admin) return { allowed: true, reason: null };

  for (const rule of rules) {
    // 函数在 public schema(PostgREST 才路由得到),但 EXECUTE 只授权给
    // service_role —— 登录用户调不了,等于对外仍不可见。见迁移 0014。
    const { data, error } = await admin.rpc("bump_rate_limit", {
      p_subject: `${subject}:${rule.windowSeconds}`,
      p_window_seconds: rule.windowSeconds,
    });

    // 计数本身出错时放行:宁可漏限一次,也不能因为限流组件故障
    // 就让所有人用不了对话。
    //
    // 但这个取舍目前有个缺口:全站没有结构化日志(pino 装了却零引用),
    // 所以限流组件一旦故障,生产上不会留下任何痕迹 —— 等于限流静默失效。
    // 接上日志之前,这里至少要让故障可见。
    if (error) {
      logger.error(
        { subject, window: rule.windowSeconds, dbError: error.message },
        "限流计数失败,本次放行",
      );
      return { allowed: true, reason: null };
    }

    // bump_rate_limit 返回的是**本次计入之后**的累计次数
    // (函数体里是 `on conflict do update set hits = hits + 1 returning hits`,
    // 首次调用返回 1)。所以 hits > max 恰好放行 max 次:
    // 第 max 次 hits == max 放行,第 max+1 次 hits == max+1 被拦。
    // 这里不是 off-by-one —— 已对照数据库里的函数定义核实过。
    const hits = typeof data === "number" ? data : 0;
    if (hits > rule.max) {
      return {
        allowed: false,
        reason: `请求过于频繁(${rule.label})。这是为了避免脚本失控把你的服务商配额刷干,请稍后再试。`,
      };
    }
  }

  return { allowed: true, reason: null };
}
