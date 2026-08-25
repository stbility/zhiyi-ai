/**
 * Runner 入口(阶段 B 骨架)。
 *
 * 长驻 Node 进程:
 *   - 连接 PostgreSQL(需 RUNNER_DATABASE_URL,service role 权限)
 *   - 启动 Runner 主循环(slot pool / claim / lease / fencing)
 *   - HTTP health 端点(:8787/healthz)
 *   - SIGTERM/SIGINT 优雅关闭
 *
 * 阶段 C 将注入 Hermes ACP execute handler(当前为占位:直接 finish)。
 */

import { createServer } from "node:http";
import pg from "pg";
import { Runner, makeWorkerId } from "./runner.js";
import { HermesACPAdapter } from "./hermes-acp-adapter.js";
import { executeAgentRun } from "./agent-execute.js";

const RUNNER_DATABASE_URL = process.env.RUNNER_DATABASE_URL;
if (!RUNNER_DATABASE_URL) {
  console.error("[runner] RUNNER_DATABASE_URL 未配置 —— Runner 无法连接 PostgreSQL");
  process.exit(1);
}

const SLOTS = Number(process.env.RUNNER_SLOTS ?? "2");
const WORKER_ID = process.env.RUNNER_WORKER_ID ?? makeWorkerId();
const ZHIYI_MCP_URL = process.env.ZHIYI_MCP_URL;
const ZHIYI_MCP_TOKEN = process.env.ZHIYI_MCP_TOKEN;

const pool = new pg.Pool({ connectionString: RUNNER_DATABASE_URL, max: SLOTS + 2 });

// 阶段 C/D:Hermes ACP Adapter + Agent execute handler
// HERMES_HOME 隔离到 ~/.hermes/hermes-runner(与 Desktop 的 ~/.hermes 分开):
// 共享 state.db/sessions 会导致 Desktop 收到 Runner 会话事件(2026-08-17 实证)。
// 模型配置(config.yaml)与 MiniMax OAuth 凭据(auth.json)由启动脚本复制过去。
const acpHome = process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes/hermes-runner`;
if (acpHome === `${process.env.HOME}/.hermes`) {
  console.error("[runner] FATAL: HERMES_HOME cannot be Desktop's ~/.hermes — isolation would be broken");
  process.exit(1);
}
const acp = new HermesACPAdapter({
  bin: process.env.HERMES_BIN,
  home: acpHome,
});
console.log(`[runner] Hermes ACP HERMES_HOME: ${acpHome}`);
await acp.start();
console.log("[runner] Hermes ACP connected");

const execute = (ctx: Parameters<typeof executeAgentRun>[0]) =>
  executeAgentRun(ctx, {
    pool,
    acp,
    zhiyiMcp: ZHIYI_MCP_URL && ZHIYI_MCP_TOKEN
      ? { url: ZHIYI_MCP_URL, token: ZHIYI_MCP_TOKEN }
      : undefined,
  });

const runner = new Runner({
  pool,
  execute,
  config: { workerId: WORKER_ID, slots: SLOTS },
});

// Health 端点(:8787/healthz)
const server = createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        ...runner.status(),
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(8787, () => {
  console.log(`[runner] health endpoint http://localhost:8787/healthz`);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`[runner] ${signal} received, shutting down...`);
  await runner.shutdown();
  server.close();
  await pool.end();
  console.log("[runner] shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// 启动主循环
console.log(`[runner] starting worker=${WORKER_ID} slots=${SLOTS}`);
runner.start();
