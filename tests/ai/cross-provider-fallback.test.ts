import { describe, expect, it, vi } from "vitest";


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
    // 但**不复述上游原话**:它可能很长,而且对用户没有可操作性。
    // 更要紧的是不下「谁不可用」的判决 —— 上游 529、我们自己协议写错、
    // 网络抖动,表现是一样的,我们经常不知道真实原因。
    expect(text).not.toContain("排队已满");
    expect(text).not.toContain("不可用");
  });
});

/**
 * 智能体**不**参与降级。
 *
 * 上面那些排序 / 凭据 / 说明的能力仍然给对话路径(AI 助手)用 ——
 * 那条线是好的,不动。但智能体这条线不用它们:用户的原话是
 * 「你选哪个就用哪个,不换」。
 *
 * 为什么要专门守一条:自动换模型在智能体上造成的是**留痕自相矛盾**。
 * 生产实况 —— 用户选 deepseek-v4-flash,messages.model_id 记的是它,
 * 而正文里写着「本次运行改用过 z-ai/glm-5.2」。同一条记录两个模型名,
 * 用户没法判断哪个是真的,合理的结论就是「这段文字是编的」。
 */
describe("智能体不换模型", () => {
  it("选定服务商跑不通就抛错,绝不拿另一家的密钥再试", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    process.env["ENCRYPTION_KEY"] = Buffer.alloc(32, 11).toString("base64");
    const { encryptSecret } = await import("@/lib/crypto/secret-box");
    const agent = await import("@/lib/ai/agent");

    const nvKey = encryptSecret("nvapi-key-of-nvidia");

    /** 每次请求实际用的 Authorization 头 */
    const authSeen: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: { headers: Record<string, string> }) => {
          authSeen.push(init.headers["Authorization"] ?? "");
          return Promise.resolve(
            new Response("ResourceExhausted: Worker limit reached", { status: 503 }),
          );
        },
      ),
    );

    await expect(
      agent.runAgent({
        model: {
          providerId: "nv",
          providerName: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          credentials: {
            kind: "openai_compatible",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKeyCipher: nvKey,
          },
        },
        userMessage: "干活",
        history: [],
        toolContext: {
          async readFile() { return null; },
          async writeFile() {},
          async listFiles() { return []; },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    // 一次请求,一把钥匙。多一次就说明降级链又长回来了。
    expect(authSeen).toHaveLength(1);
    expect(authSeen[0]).toContain("nvapi-key-of-nvidia");
    vi.unstubAllGlobals();
  });
});
