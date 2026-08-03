import { describe, expect, it, vi } from "vitest";

import { sseResponse } from "../helpers/sse";

/**
 * 跨服务商降级。
 *
 * 这组测试守的是把整个产品打死过一次的缺陷。
 *
 * 降级链原本被锁在用户选中的那**一个** provider 内:
 *   .from("ai_models").eq("provider_id", providerId)
 *
 * 而 fallback.ts 的设计注释写得很清楚:「同厂商的模型往往共用一个算力池,
 * 堵的时候通常整家都堵。降级要优先跨厂商 —— 否则换了等于没换。」
 *
 * 实现恰恰就是在一家里打转。原因是 vendorOf() 按模型标识里的 `/` 前缀
 * 判断「厂商」:在英伟达上 deepseek-ai/…、z-ai/…、moonshotai/… 看起来是
 * 三个厂商,实际全是英伟达一家的算力池。
 *
 * 生产实测的后果:英伟达容量塌陷时同一时刻
 *   NVIDIA   deepseek-v4-flash  284 秒 / 18 token
 *   DeepSeek 官方 同名模型       65 秒 / 6353 token
 * 差两个数量级 —— 而用户明明配好了 DeepSeek 官方,系统一次都没试过它。
 * 三个候选全在英伟达、全部超时,对话与智能体两条线同时不工作。
 *
 * 所以这里断言的是**顺序**和**凭据**,不是「能不能跑通」。
 */

async function load() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return await import("@/lib/ai/candidates");
}

/** 英伟达上的四个模型:标识前缀看着是四家,其实同一个算力池 */
const nvidia = [
  { providerId: "nv", providerName: "nvidia", kind: "openai_compatible" as const, baseUrl: null, modelId: "deepseek-ai/deepseek-v4-flash" },
  { providerId: "nv", providerName: "nvidia", kind: "openai_compatible" as const, baseUrl: null, modelId: "deepseek-ai/deepseek-v4-pro" },
  { providerId: "nv", providerName: "nvidia", kind: "openai_compatible" as const, baseUrl: null, modelId: "z-ai/glm-5.2" },
  { providerId: "nv", providerName: "nvidia", kind: "openai_compatible" as const, baseUrl: null, modelId: "moonshotai/kimi-k2.6" },
];
const deepseek = [
  { providerId: "ds", providerName: "deepseek", kind: "openai_compatible" as const, baseUrl: null, modelId: "deepseek-chat" },
];
const zhipu = [
  { providerId: "zp", providerName: "bigmodel", kind: "openai_compatible" as const, baseUrl: null, modelId: "glm-4" },
];

describe("候选排序", () => {
  it("用户选的排第一 —— 他的意图优先", async () => {
    const { orderCandidates } = await load();
    const chain = orderCandidates(
      [...nvidia, ...deepseek],
      "nv",
      "z-ai/glm-5.2",
    );
    expect(chain[0]?.providerId).toBe("nv");
    expect(chain[0]?.modelId).toBe("z-ai/glm-5.2");
  });

  it("第二个必须是**别的服务商** —— 这条就是整个修复的意义", async () => {
    const { orderCandidates } = await load();
    const chain = orderCandidates(
      [...nvidia, ...deepseek],
      "nv",
      "z-ai/glm-5.2",
    );
    // 修复前:第二个是 deepseek-ai/deepseek-v4-flash —— 还在英伟达上,
    // 英伟达塌了它也一样塌,换了等于没换
    expect(chain[1]?.providerId).toBe("ds");
  });

  it("前三个候选尽可能落在不同的服务商上,不扎堆在一家", async () => {
    const { orderCandidates } = await load();
    const chain = orderCandidates(
      [...nvidia, ...deepseek, ...zhipu],
      "nv",
      "z-ai/glm-5.2",
    ).slice(0, 3);

    const providers = new Set(chain.map((c) => c.providerId));
    // 三次尝试砸在同一家 = 三次一起失败。必须分散
    expect(providers.size).toBe(3);
  });

  it("只有一家服务商时,退回同家的其它模型家族,而不是空手", async () => {
    const { orderCandidates } = await load();
    const chain = orderCandidates(nvidia, "nv", "z-ai/glm-5.2");
    expect(chain.length).toBe(nvidia.length);
    expect(chain[0]?.modelId).toBe("z-ai/glm-5.2");
    // 同家之内也要先换模型家族,不在同一个家族里打转
    expect(chain[1]?.modelId.startsWith("z-ai/")).toBe(false);
  });

  it("候选不重复 —— 同一个「服务商+模型」只出现一次", async () => {
    const { orderCandidates } = await load();
    const chain = orderCandidates([...nvidia, ...deepseek], "nv", "z-ai/glm-5.2");
    const keys = chain.map((c) => `${c.providerId}::${c.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("用户选的模型已不在列表里时,其余候选照常可用", async () => {
    const { orderCandidates } = await load();
    // 模型刚被删、或列表还没刷新
    const chain = orderCandidates([...deepseek, ...zhipu], "nv", "已删除的模型");
    expect(chain.length).toBe(2);
    expect(chain.map((c) => c.providerId)).toContain("ds");
  });
});

describe("凭据跟着候选走", () => {
  it("每个服务商用自己的密钥,同一家只解一次", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const loaded: string[] = [];
    vi.doMock("@/lib/ai/credentials", () => ({
      loadProviderCipher: async (id: string) => {
        loaded.push(id);
        return `cipher-of-${id}`;
      },
      loadIntegrationCipher: async () => null,
    }));
    const { createCredentialLoader } = await import("@/lib/ai/candidates");

    const forCandidate = createCredentialLoader();
    const a = await forCandidate(nvidia[0]!);
    const b = await forCandidate(nvidia[1]!); // 同一家
    const c = await forCandidate(deepseek[0]!); // 换一家

    // 拿 A 家的 key 去调 B 家的模型只会得到 401 —— 凭据必须跟着候选换
    expect(a?.apiKeyCipher).toBe("cipher-of-nv");
    expect(c?.apiKeyCipher).toBe("cipher-of-ds");
    expect(b?.apiKeyCipher).toBe(a?.apiKeyCipher);
    // 同一家只解一次密钥,不重复往数据库跑
    expect(loaded).toEqual(["nv", "ds"]);
    vi.doUnmock("@/lib/ai/credentials");
  });

  it("密钥读不出来时返回 null,由调用方跳过这家", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/ai/credentials", () => ({
      loadProviderCipher: async () => null,
      loadIntegrationCipher: async () => null,
    }));
    const { createCredentialLoader } = await import("@/lib/ai/candidates");
    expect(await createCredentialLoader()(nvidia[0]!)).toBeNull();
    vi.doUnmock("@/lib/ai/credentials");
  });
});

describe("换服务商的说明", () => {
  it("跨服务商时把两边的服务商名都说出来", async () => {
    const { describeSwitch } = await load();
    const text = describeSwitch(
      { providerName: "nvidia", modelId: "z-ai/glm-5.2" },
      deepseek[0]!,
      "排队已满",
    );
    // 悄悄换等于伪造来源:用户必须知道这次回答其实是别家跑的
    expect(text).toContain("nvidia");
    expect(text).toContain("deepseek");
    expect(text).toContain("排队已满");
  });
});

describe("智能体端到端:一家塌了换另一家", () => {
  it("换服务商时,请求真的带上了**新那家**的密钥", async () => {
    // 这一条是整个修复的落点。修复前 runAgent 只有一个固定的 credentials,
    // 降级只换模型名 —— 于是换到别家也还是拿旧密钥去调,必然 401。
    // 这里断言的不是「换没换」,而是「换过去的那次请求用的是谁的钥匙」。
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    process.env["ENCRYPTION_KEY"] = Buffer.alloc(32, 11).toString("base64");
    const { encryptSecret } = await import("@/lib/crypto/secret-box");
    const agent = await import("@/lib/ai/agent");

    const nvKey = encryptSecret("nvapi-key-of-nvidia");
    const dsKey = encryptSecret("sk-key-of-deepseek");

    /** 每次请求实际用的 Authorization 头 */
    const authSeen: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => {
          authSeen.push(init.headers["Authorization"] ?? "");
          const model = (JSON.parse(init.body) as { model: string }).model;
          // 英伟达那家永远排队
          if (model === "deepseek-ai/deepseek-v4-flash") {
            return Promise.resolve(
              new Response("ResourceExhausted: Worker limit reached", { status: 503 }),
            );
          }
          return Promise.resolve(
            sseResponse({
              content: "别家把活干完了。",
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        },
      ),
    );

    const r = await agent.runAgent({
      candidates: [
        {
          providerId: "nv",
          providerName: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          credentials: { kind: "openai_compatible", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyCipher: nvKey },
        },
        {
          providerId: "ds",
          providerName: "deepseek",
          modelId: "deepseek-chat",
          credentials: { kind: "openai_compatible", baseUrl: "https://api.deepseek.com/v1", apiKeyCipher: dsKey },
        },
      ],
      userMessage: "干活",
      history: [],
      toolContext: {
        async readFile() { return null; },
        async writeFile() {},
        async listFiles() { return []; },
      },
      signal: new AbortController().signal,
    });

    expect(r.answer).toBe("别家把活干完了。");
    // 两次请求,两把不同的钥匙 —— 第二次绝不能还带着英伟达的
    expect(authSeen).toHaveLength(2);
    expect(authSeen[0]).toContain("nvapi-key-of-nvidia");
    expect(authSeen[1]).toContain("sk-key-of-deepseek");
    // 而且要如实告诉用户换到了哪一家
    expect(r.usedModels.join("、")).toContain("deepseek");
    vi.unstubAllGlobals();
  });
});
