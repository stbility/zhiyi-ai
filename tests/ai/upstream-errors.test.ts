import { describe, expect, it, vi } from "vitest";

/**
 * 服务商错误翻译测试。
 *
 * 真实案例:NVIDIA 返回
 *   ResourceExhausted: Worker local total request limit reached (3228/48)
 * 直接抛给用户毫无意义 —— 它的实际含义是「这个模型此刻排队爆满」,
 * 用户该做的是换模型或稍后重试。翻译必须指向可执行的下一步。
 *
 * 同时保证:未收录的错误保留原文,绝不粉饰成笼统的「操作失败」。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/ai/gateway");
}

describe("服务商错误翻译", () => {
  it("容量耗尽 → 建议换模型或稍后重试", async () => {
    const { translateUpstreamError } = await load();
    const text = translateUpstreamError(
      "ResourceExhausted: Worker local total request limit reached (3228/48)",
    );
    expect(text).toContain("排队已满");
    expect(text).toContain("换一个模型");
    // 不该把 3228/48 这种内部计数丢给用户
    expect(text).not.toContain("3228");
  });

  it("限流 → 提示稍等", async () => {
    const { translateUpstreamError } = await load();
    expect(translateUpstreamError("rate limit exceeded")).toContain("限流");
    expect(translateUpstreamError("Too Many Requests")).toContain("限流");
  });

  it("上下文超长 → 建议新开对话", async () => {
    const { translateUpstreamError } = await load();
    const text = translateUpstreamError(
      "This model's maximum context length is 8192 tokens",
    );
    expect(text).toContain("上下文");
    expect(text).toContain("新开");
  });

  it("模型下线 → 指向重新测试连接", async () => {
    const { translateUpstreamError } = await load();
    const text = translateUpstreamError("The model `foo` does not exist");
    expect(text).toContain("模型服务");
  });

  it("密钥问题 → 指向检查密钥", async () => {
    const { translateUpstreamError } = await load();
    expect(translateUpstreamError("invalid api key")).toContain("密钥");
    expect(translateUpstreamError("Unauthorized")).toContain("密钥");
  });

  it("额度不足 → 指向服务商账户", async () => {
    const { translateUpstreamError } = await load();
    expect(translateUpstreamError("insufficient quota")).toContain("额度");
  });

  it("未收录的错误保留原文,不吞不粉饰", async () => {
    const { translateUpstreamError } = await load();
    const raw = "Something entirely unexpected happened upstream";
    expect(translateUpstreamError(raw)).toContain(raw);
  });

  it("空回复解释会复用同一套翻译", async () => {
    const { explainEmptyResponse } = await load();
    const text = explainEmptyResponse({
      finishReason: null,
      streamError: "ResourceExhausted: Worker local total request limit reached",
      seenDeltaKeys: [],
      chunkCount: 1,
    });
    expect(text).toContain("排队已满");
  });
});

/**
 * HTTP 状态码 → 诊断文案。
 *
 * 这里守的是「诊断有没有把人指对方向」。真实教训:英伟达对
 * 「账号没开通这个模型」返回的也是 404,原话是
 *   Function '<uuid>': Not found for account '<账号指纹>'
 * 而我们一律回「请检查接口地址与模型名称」—— 把用户支使去改一个
 * 根本没坏的地方,真正该做的事(去服务商控制台开通)一个字没提。
 * 用户因此认为是系统把模型弄坏了。
 */
describe("HTTP 失败诊断", () => {
  function res(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status });
  }

  it("没开通的 404 说清是账号权限,而不是让人去改地址和名称", async () => {
    const { describeFailure } = await load();
    const text = await describeFailure(
      res(404, {
        detail:
          "Function '23d4f03a-b8a6-4adb-a183-7daa083a09cc': Not found for account 'AOVVcakqua2HYhK_tMcyp9_gdM'",
      }),
      "moonshotai/kimi-k2.6",
    );

    expect(text).toContain("没有调用权限");
    expect(text).toContain("开通");
    // 关键:不能再让用户去改根本没错的东西
    expect(text).not.toContain("请检查接口地址与模型名称");
    // 要点名是哪个模型 —— 多模型并存时不点名等于没说
    expect(text).toContain("moonshotai/kimi-k2.6");
    // 内部函数编号与账号指纹对用户没有意义,只会让报错更吓人
    expect(text).not.toContain("23d4f03a");
    expect(text).not.toContain("AOVVcakqua2HYhK");
  });

  it("真的写错了的 404 仍然提示检查地址与名称", async () => {
    const { describeFailure } = await load();
    const text = await describeFailure(
      res(404, { error: { message: "The model `gpt-9` does not exist" } }),
      "gpt-9",
    );
    expect(text).toContain("请检查接口地址与模型名称");
    expect(text).not.toContain("没有调用权限");
  });

  it("上游原话始终保留,不粉饰", async () => {
    const { describeFailure } = await load();
    const text = await describeFailure(
      res(500, { error: { message: "internal boom" } }),
      "m1",
    );
    expect(text).toContain("internal boom");
    expect(text).toContain("m1");
  });
});
