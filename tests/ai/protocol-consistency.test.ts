import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sseResponse } from "../helpers/sse";

/**
 * 请求协议与解析协议必须是同一个。
 *
 * 这条守卫来自一个活了很久的 bug,而它能活这么久正是因为**测试是绿的**。
 *
 * 经过:我把 callWithTools 的解析器改成读 SSE(assembleToolStream),
 * 同时把测试夹具也改成了 SSE —— 但请求体里那行 `stream: false`
 * 因为脚本中途异常没写进去。于是:
 *
 *   生产:请求非流式 → 上游回单个 JSON → 解析器找不到任何 `data:` 行
 *        → 返回空文本 + 零工具调用
 *        → 智能体报「模型既没有调用工具也没有给出回答」
 *   测试:夹具是 SSE → 解析器工作正常 → 全绿
 *
 * 测试测的是一个**产品里不存在的协议组合**。这不是假绿,是两端各测各的。
 *
 * 所以这里同时钉两头:
 *   1. 源码断言:请求体必须 stream: true(和解析器对齐)
 *   2. 行为断言:把上游换成**非流式**的单个 JSON,必须明确失败,
 *      而不是静悄悄地返回「什么都没有」——
 *      静默返回空,就是上面那个 bug 的全部成因。
 */

const GATEWAY = readFileSync(
  resolve(__dirname, "../../src/lib/ai/gateway.ts"),
  "utf8",
);

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  process.env["ENCRYPTION_KEY"] = Buffer.alloc(32, 21).toString("base64");
  const { encryptSecret } = await import("@/lib/crypto/secret-box");
  const gateway = await import("@/lib/ai/gateway");
  return { gateway, cipher: encryptSecret("k") };
}

const creds = (cipher: string) => ({
  kind: "openai_compatible" as const,
  baseUrl: "https://api.example.com/v1",
  apiKeyCipher: cipher,
});

describe("工具调用的请求端与解析端必须对齐", () => {
  it("请求体是 stream: true —— 解析器读的是 SSE", () => {
    // 抓 callWithTools 那一段的请求体
    const block = GATEWAY.slice(GATEWAY.indexOf("export async function callWithTools"));
    // 切到 fetch 调用结束为止 —— 注释里也会提到 assembleToolStream,
    // 不能拿它当边界
    const body = block.slice(0, block.indexOf("signal: combined"));
    expect(body).toMatch(/stream:\s*true/);
    expect(body).not.toMatch(/stream:\s*false/);
  });

  it("请求了用量 —— 流式下不带 include_usage 就拿不到 token 数", () => {
    const block = GATEWAY.slice(GATEWAY.indexOf("export async function callWithTools"));
    // 切到 fetch 调用结束为止 —— 注释里也会提到 assembleToolStream,
    // 不能拿它当边界
    const body = block.slice(0, block.indexOf("signal: combined"));
    expect(body).toMatch(/include_usage/);
  });
});

describe("上游若回了非流式响应,必须明确失败", () => {
  it("不能静默返回「空文本 + 零工具调用」", async () => {
    const { gateway, cipher } = await load();
    // 单个 JSON,不是 SSE —— 正是 stream: false 时上游的样子
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "你好" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const err = await gateway
      .callWithTools({
        credentials: creds(cipher),
        model: "m",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      })
      .then(() => null)
      .catch((e: unknown) => e);

    // 这一条是整条守卫的核心:如果解析器把非流式响应读成「什么都没有」,
    // 智能体就会报「模型既没有调用工具也没有给出回答」,而问题在我们这一侧。
    // 宁可明确失败,不可静默返回空。
    expect(err, "解析非流式响应没有报错 —— 那正是那个 bug 的形态").toBeInstanceOf(
      gateway.ProviderCallError,
    );
    expect((err as Error).message).toMatch(/协议/);
    vi.unstubAllGlobals();
  });
});

describe("流式解析本身", () => {
  it("分片到达的工具参数能被正确累积", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse({
          toolCalls: [
            {
              name: "write_file",
              args: { path: "src/a.ts", content: "export const a = 1;" },
            },
          ],
        }),
      ),
    );

    const turn = await gateway.callWithTools({
      credentials: creds(cipher),
      model: "m",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    expect(turn.toolCalls).toHaveLength(1);
    // 参数是分两片发的,拼错一个字符就解析不出来
    expect(JSON.parse(turn.toolCalls[0]!.rawArguments)).toEqual({
      path: "src/a.ts",
      content: "export const a = 1;",
    });
    vi.unstubAllGlobals();
  });

  it("finish_reason 会被带回来 —— 它是上游给的权威信号", async () => {
    const { gateway, cipher } = await load();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse({ content: "好", finishReason: "stop" })),
    );

    const turn = await gateway.callWithTools({
      credentials: creds(cipher),
      model: "m",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });

    expect(turn.finishReason).toBe("stop");
    vi.unstubAllGlobals();
  });
});
