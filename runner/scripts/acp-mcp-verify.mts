// ACP + MCP 真实链路验证 v2(多工具 + Continuation)
// 修正:tool_call 名称在 title 字段;tool_result 事件可能无独立 event,
// 以 tool_call + 最终回答为准。
import { spawn } from "node:child_process";
import * as readline from "node:readline";

const HERMES_BIN = process.env.HERMES_BIN ?? `${process.env.HOME}/.hermes/hermes-agent/venv/bin/hermes`;
const ZHIYI_MCP_URL = process.env.ZHIYI_MCP_URL!;
const ZHIYI_MCP_TOKEN = process.env.ZHIYI_MCP_TOKEN!;

const child = spawn(HERMES_BIN, ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HERMES_HOME: process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes` },
});

let seq = 0;
let sid: string | null = null;
const toolCalls: { name: string; id: string }[] = [];
let finalText = "";
let thoughtCount = 0;
let messageCount = 0;

function send(method: string, params: unknown): number {
  const id = ++seq;
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

const rl = readline.createInterface({ input: child.stdout! });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(t); } catch { return; }

  if (msg.id === 1) {
    console.log("[1] ACP initialize: OK");
    send("session/new", {
      cwd: "/tmp",
      mcpServers: [{ name: "zhiyi", transport: "http", type: "http", url: ZHIYI_MCP_URL, headers: [{ name: "Authorization", value: `Bearer ${ZHIYI_MCP_TOKEN}` }] }],
    });
  } else if (msg.id === 2) {
    const r = msg.result as Record<string, unknown> | undefined;
    sid = (r?.sessionId as string) ?? (r?.session_id as string) ?? null;
    console.log("[2] session/new: OK | session:", sid?.slice(0, 12) + "...");
    const task =
      "请依次调用 zhiyi_whoami、zhiyi_workspace_list、zhiyi_git_list_files、zhiyi_git_read_file(参数 path 传 'README.md') 这四个工具,基于它们返回的真实结果,汇总告诉我:组织名称、工作区概况、仓库文件列表,以及 README.md 的第一行内容。";
    console.log("[3] prompt(多工具)...");
    send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: task }] });
  } else if (msg.method === "session/update") {
    const u = (msg.params as Record<string, unknown>)?.update as Record<string, unknown> | undefined;
    const kind = String(u?.sessionUpdate ?? "");
    const content = (u?.content ?? {}) as Record<string, unknown>;
    if (kind === "agent_message_chunk" && content.text) {
      messageCount++;
      finalText += content.text;
    } else if (kind === "agent_thought_chunk") {
      thoughtCount++;
    } else if (kind === "tool_call") {
      // 实证:工具名在 title 字段(如 "mcp__zhiyi__zhiyi_whoami")
      const name = String(u?.title ?? "?");
      toolCalls.push({ name, id: String(u?.toolCallId ?? "?") });
      console.log(`[tool_call] ${name}`);
    } else if (kind === "tool_result" || (kind === "other" && String(u?.title ?? "").includes("zhiyi"))) {
      // tool_result 可能以 other + title 出现(无独立 event,无需解析)
    }
  } else if (msg.id === 3) {
    console.log("[4] prompt 完成");
    console.log("=== 统计 ===");
    console.log("tool_calls:", toolCalls.map((t) => t.name.replace("mcp__zhiyi__", "")).join(" → ") || "(无)");
    console.log("thought_chunks:", thoughtCount, "| message_chunks:", messageCount);
    console.log("=== 最终回答 ===");
    console.log(finalText.slice(0, 1200));
    console.log("=== 判定 ===");
    const called = (n: string) => toolCalls.some((t) => t.name.includes(n));
    console.log("zhiyi_whoami:", called("zhiyi_whoami") ? "CALLED" : "NO");
    console.log("zhiyi_workspace_list:", called("zhiyi_workspace_list") ? "CALLED" : "NO");
    console.log("zhiyi_git_list_files:", called("zhiyi_git_list_files") ? "CALLED" : "NO");
    console.log("zhiyi_git_read_file:", called("zhiyi_git_read_file") ? "CALLED" : "NO");
    const hasOrg = /zhiyi-ai|组织/i.test(finalText);
    const hasReadme = /README|readme/i.test(finalText);
    console.log("回答含组织信息:", hasOrg ? "YES" : "NO");
    console.log("回答含 README 内容:", hasReadme ? "YES" : "NO");
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  }
});

child.stderr.on("data", (d: Buffer) => {
  const s = d.toString();
  if (s.includes("[ERROR]")) console.log("[stderr-ERR]", s.split("\n")[0].slice(0, 130));
});

send("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zhiyi-acp-mcp-verify", version: "0.2.0" } });

setTimeout(() => {
  console.log("TIMEOUT 240s");
  child.kill("SIGKILL");
  process.exit(3);
}, 240_000);
