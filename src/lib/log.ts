import "server-only";

import pino from "pino";

/**
 * 结构化日志。
 *
 * 此前 pino 装了却零引用,全站唯一的日志是错误边界里的一句 console.error。
 * 后果很具体:限流组件故障时会 fail-open 放行,而这个故障在生产上
 * 不留任何痕迹 —— 等于限流静默失效却没人知道。写库被 RLS 拒绝同理。
 *
 * 配置上的两个决定:
 *
 * 1. **不挂 transport。** pino 的 pretty transport 走 worker 线程,
 *    在 Vercel 的无服务器函数里会因为进程被随时冻结而丢日志甚至报错。
 *    默认行为(直接往 stdout 写一行 JSON)恰恰是 Vercel 想要的 ——
 *    它会自动采集 stdout 并按 JSON 解析。开发环境可读性稍差,
 *    但比在生产上丢日志强得多。
 *
 * 2. **redact 兜底。** 日志最容易泄密。这里把常见的密钥字段名列进
 *    redact,即使调用方不小心把整个对象丢进来也不会写出明文。
 *    但这只是兜底 —— 调用方仍然不该往日志里放密钥。
 */
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { app: "zhiyi-ai" },
  redact: {
    paths: [
      "apiKey",
      "api_key",
      "apiKeyCipher",
      "api_key_cipher",
      "credentialCipher",
      "credential_cipher",
      "password",
      "token",
      "authorization",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "*.token",
    ],
    censor: "[已隐去]",
  },
});

/**
 * 记录一次「本该成功却失败了」的数据库写入。
 *
 * 这类失败此前全部静默:RLS 拒绝时 PostgREST 返回错误但代码不检查,
 * 于是模型照常被调用、配额照常消耗、流照常返回给用户,只是什么都没存下来。
 * 而 messages 表正是「后续做用量计费与权益控制的唯一依据」——
 * 静默失败会让计费依据直接失真。
 */
export function logDbFailure(
  operation: string,
  error: { message: string; code?: string | undefined },
  context: Record<string, unknown> = {},
): void {
  logger.error(
    { operation, dbError: error.message, dbCode: error.code, ...context },
    "数据库写入失败",
  );
}
