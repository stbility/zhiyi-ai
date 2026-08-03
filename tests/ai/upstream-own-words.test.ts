import { describe, expect, it, vi } from "vitest";

/**
 * 上游自己说了话,就用上游的话 —— 我们不在前面加转述。
 *
 * 这组守卫来自一次真实投诉。上游回的是:
 *
 *   HTTP 529   Service temporarily overloaded
 *
 * 我们显示成:
 *
 *   模型 X:服务商暂时不可用(HTTP 529)。服务商原话:Service temporarily overloaded
 *
 * 事实一个都没编 —— 状态码是 response.status,原话是响应体,模型名是本次
 * 实际调用的那个。但「overloaded」是**过载、太忙**,「不可用」是**挂了**。
 * 对用户这是两个完全相反的判断:前者意味着等一下再试,后者意味着这家废了。
 * 我们把人家的话改了意思,又把原话附在后面 —— 同一行里两个打架的说法,
 * 用户凭什么信哪一个。
 *
 * 更要命的是那句转述**毫无必要**:上游已经把话说清楚了,就在同一行后半截。
 *
 * 这跟「对话框里只留模型自己说的话」是同一条规则,只是主语从模型换成了
 * 服务商。所以这里守两头:
 *   · 有原话时,原话必须原样出现,而且前面不许有我们的转述
 *   · 没原话时,只陈述我们确实知道的那件事(收到了这个状态码),不推断原因
 *
 * 之所以要专门写这个文件:改之前这段行为**一条守卫都没有** ——
 * 我把那句错误的转述删掉时,15 个既有测试全绿。没有测试的措辞,
 * 就是下一次悄悄跑偏的地方。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return await import("@/lib/ai/gateway");
}

const upstream = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "application/json" } });

describe("上游给了原话时,原话说了算", () => {
  it("529 overloaded —— 不许改写成「不可用」", async () => {
    const { describeFailure } = await load();
    const msg = await describeFailure(
      upstream(529, JSON.stringify({ error: "Service temporarily overloaded" })),
      "deepseek-ai/deepseek-v4-flash",
    );

    // 上游的原话必须原样在里面
    expect(msg).toContain("Service temporarily overloaded");
    expect(msg).toContain("529");
    // 出错的是哪个模型要点名 —— 多个模型并存时不点名等于没说
    expect(msg).toContain("deepseek-ai/deepseek-v4-flash");

    // 而这几个词是我们的推断,不是上游说的。
    // 「overloaded」= 忙,「不可用」= 坏,把前者说成后者会让用户
    // 去停用一个其实好好的服务商。
    expect(msg, "把 overloaded 说成了不可用").not.toContain("不可用");
    expect(msg).not.toContain("暂时不可用");
    // 原话已经在前面了,不需要再用「服务商原话:」把它介绍一遍
    expect(msg).not.toContain("服务商原话");
  });

  it("429 限流 —— 同样以上游原话为准,不套固定文案", async () => {
    const { describeFailure } = await load();
    const msg = await describeFailure(
      upstream(429, JSON.stringify({ error: { message: "rate limit exceeded, retry in 12s" } })),
      "m",
    );

    // 「retry in 12s」这种具体信息只有上游知道,固定文案会把它整个丢掉
    expect(msg).toContain("rate limit exceeded, retry in 12s");
    expect(msg).not.toContain("请稍后重试");
  });

  it("500 —— 不替上游解释为什么", async () => {
    const { describeFailure } = await load();
    const msg = await describeFailure(
      upstream(500, JSON.stringify({ error: "internal error in scheduler" })),
      "m",
    );
    expect(msg).toContain("internal error in scheduler");
    expect(msg).not.toContain("不可用");
  });
});

describe("上游一个字都没给时", () => {
  it("只说收到了这个状态码,不推断原因", async () => {
    const { describeFailure } = await load();
    const msg = await describeFailure(new Response("", { status: 502 }), "m");

    expect(msg).toContain("502");
    // 我们确实不知道它为什么 502。任何一句「服务商挂了」「请稍后重试」
    // 都是在猜,而猜错的代价由用户承担 —— 他会照着这句话去做无用功。
    expect(msg).not.toContain("不可用");
    expect(msg).not.toContain("请稍后");
    expect(msg).toContain("没有附带任何说明");
  });
});

describe("翻译可以有,替换不行", () => {
  it("404 没开通 —— 给出可操作的指引,但原话必须一并保留", async () => {
    const { describeFailure } = await load();
    const msg = await describeFailure(
      upstream(404, JSON.stringify({ detail: "Not found for account" })),
      "m",
    );

    // 这一支保留我们的翻译:上游那句「Not found for account」本身
    // 不可操作 —— 它不告诉用户该去哪儿点哪个按钮。
    expect(msg).toContain("没有调用权限");
    // 但翻译不能吃掉原话。用户要能自己核对我们翻得对不对。
    expect(msg).toContain("Not found for account");
  });

  it("403 密钥问题 —— 同样保留原话", async () => {
    const { describeFailure } = await load();
    const msg = await describeFailure(
      upstream(403, JSON.stringify({ error: "Authorization failed" })),
      "m",
    );
    expect(msg).toContain("Authorization failed");
  });
});
