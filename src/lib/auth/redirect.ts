/**
 * 登录后回跳地址净化。
 *
 * `next` 参数来自 URL,是不可信输入。若不加限制地用它做重定向,就构成开放重定向:
 * 攻击者能用我们自己的域名把刚登录的用户导向钓鱼站,而地址栏一开始显示的是可信域名。
 *
 * 只接受站内相对路径。以下形态必须全部拒绝:
 *   //evil.com        —— 协议相对地址,浏览器会当成外站
 *   /\evil.com        —— 部分浏览器等同于 //
 *   https://evil.com  —— 绝对地址
 *   javascript:...    —— 伪协议
 */
export const DEFAULT_REDIRECT = "/today";

export function safeRedirectPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (!raw) return fallback;

  const value = raw.trim();
  if (value === "") return fallback;

  // 必须是单个 / 开头的站内路径
  if (!value.startsWith("/")) return fallback;

  // 协议相对地址与其变体
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;

  // 控制字符(含换行、制表、NUL)可用于绕过前缀检查或注入响应头
  if (/[\u0000-\u001F\u007F]/.test(value)) return fallback;

  return value;
}
