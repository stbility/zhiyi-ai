import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { classifyFailure, shouldRetry, describeFailureKind, MAX_ATTEMPTS } =
  await import("@/lib/ai/failure-kind");
const { ProviderCallError } = await import("@/lib/ai/gateway");
const { EncryptionUnavailableError } = await import("@/lib/crypto/secret-box");

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

/**
 * 剥注释再断言。
 *
 * 「不许再出现老写法」这类守卫,必须只看**会执行的代码** ——
 * 记录旧缺陷的注释里天然会引用那段旧写法,按原文搜会把最有价值的
 * 注释判成违规,逼着人把它删掉。这个坑本次会话里已经踩过两次。
 */
const 去注释 = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 真实缺陷:重试判据写成
 *
 *   const 断连 = !(e instanceof ProviderCallError);
 *   const 可重试 = 断连 || isTransientFailure(...);
 *
 * ——**任何**不认识的异常都被当成传输故障而重试。落进这个口子的包括
 * decryptSecret 抛的密钥错误、数据库/RLS 错误、以及代码 bug 抛的 TypeError。
 *
 * 这些错误**一次上游都没调到**,却会退避 1+2+4+8+8… 烧掉整个预算
 * (约 285 秒)。用户干等三分半,页面看起来像模型服务商很慢,
 * 而请求从未离开我们的服务器。
 *
 * 根子是**默认放行**。这里全部反过来。
 */
describe("我们自己的错误立刻停,绝不重试", () => {
  const 平台错误: ReadonlyArray<readonly [unknown, string]> = [
    [new EncryptionUnavailableError("密文格式无法识别。"), "密钥解不开"],
    [new Error("Unsupported state or unable to authenticate data"), "密文被改过(authTag 校验失败)"],
    [new Error('new row violates row-level security policy for table "messages"'), "RLS 挡下"],
    [new Error('null value in column "created_by" violates not-null constraint'), "数据库约束"],
    [new Error("invalid input syntax for type uuid"), "参数格式错"],
    [new Error("PGRST116: JSON object requested, multiple rows returned"), "PostgREST 错误"],
    [new TypeError("x.map is not a function"), "代码 bug"],
    [new Error("permission denied for table ai_providers"), "表权限不足"],
  ];

  for (const [err, 说明] of 平台错误) {
    it(`${说明} → platform,不重试`, () => {
      expect(classifyFailure(err)).toBe("platform");
      expect(shouldRetry(classifyFailure(err))).toBe(false);
    });
  }

  it("认不出来的一律当我们的问题 —— 默认拒绝,不是默认放行", () => {
    // 立刻失败最坏是让用户重试一次;默认重试最坏是让他白等三分半
    expect(classifyFailure({ 不是: "错误对象" })).toBe("platform");
    expect(classifyFailure(null)).toBe("platform");
    expect(classifyFailure("字符串")).toBe("platform");
  });

  it("报错要明说「请求没发出去」", () => {
    // 不说的话,用户会去查服务商状态、换模型、重连账号 ——
    // 而问题全在我们这边。这一句能省掉他一整轮排查
    const msg = describeFailureKind("platform", "密文格式无法识别。");
    expect(msg).toMatch(/未发送到模型服务商/);
    expect(msg).toMatch(/与模型快慢无关/);
  });
});

describe("上游的临时故障才重试", () => {
  const 可重试 = [429, 500, 502, 503, 504] as const;
  for (const status of 可重试) {
    it(`HTTP ${status} → upstream-transient`, () => {
      const e = new ProviderCallError("服务暂时不可用", status);
      expect(classifyFailure(e)).toBe("upstream-transient");
      expect(shouldRetry(classifyFailure(e))).toBe(true);
    });
  }

  // 文字形态的断连也要认。这一条是被 agent.test.ts 抓出来的:
  // 流在开口之前断掉时抛的是 `connection reset by peer` —— 没有 errno。
  // 只认 errno 的话,一次真实断连会被判成平台错误直接失败,
  // 比原来的缺陷更糟。
  const 文字形态断连 = [
    "connection reset by peer",
    "socket hang up",
    "Premature close",
    "terminated",
    "fetch failed",
  ];
  for (const msg of 文字形态断连) {
    it(`「${msg}」→ transport,重试`, () => {
      expect(classifyFailure(new Error(msg))).toBe("transport");
    });
  }

  it("网络断了 → transport,重试(请求可能压根没送到)", () => {
    const e = new TypeError("fetch failed");
    (e as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED"),
      { code: "ECONNREFUSED" },
    );
    expect(classifyFailure(e)).toBe("transport");
    expect(shouldRetry(classifyFailure(e))).toBe(true);
  });
});

describe("权限单独一档 —— 等多久都不会好", () => {
  for (const status of [401, 403] as const) {
    it(`HTTP ${status} → permission,不重试`, () => {
      const e = new ProviderCallError("Invalid API key", status);
      expect(classifyFailure(e)).toBe("permission");
      expect(shouldRetry(classifyFailure(e))).toBe(false);
    });
  }

  it("文案指向「换凭据」,不是「换模型」", () => {
    // 混进 upstream-permanent 的话,报错会写成「模型不存在」这类,
    // 把人支去换模型 —— 而该改的是凭据
    expect(describeFailureKind("permission", "Invalid API key")).toMatch(
      /更换或重新授权/,
    );
  });
});

describe("上游的永久性失败不重试", () => {
  it("404 模型不存在 → upstream-permanent", () => {
    const e = new ProviderCallError("model not found", 404);
    expect(classifyFailure(e)).toBe("upstream-permanent");
    expect(shouldRetry(classifyFailure(e))).toBe(false);
  });
});

describe("每条路径都有次数上限", () => {
  it("上限是个有限的小数", () => {
    // 只看预算的话,一个 1 秒就失败的错误会在 285 秒里被重试几十次 ——
    // 日志刷屏、上游被打、用户干等
    expect(MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it("对话路径按次数封顶,不只靠剩余预算", () => {
    const CHAT = read("src/app/api/chat/route.ts");
    expect(CHAT).toMatch(/attempt < MAX_ATTEMPTS/);
  });

  it("智能体路径也有上限", () => {
    const AGENT = read("src/lib/ai/agent.ts");
    expect(AGENT).toMatch(/attempt > limits\.maxRetries/);
  });

  it("两条路径用的是同一个分类器", () => {
    // 各写一份的话,同一个错误在两条路上会被判成不同的类 ——
    // 而这正是本次缺陷的形态(两处各写了一遍 `!(e instanceof ...)`)
    for (const f of ["src/app/api/chat/route.ts", "src/lib/ai/agent.ts"]) {
      const 代码 = 去注释(read(f));
      expect(代码, `${f} 没有走统一分类器`).toContain("classifyFailure");
      expect(
        代码,
        `${f} 还留着「不是 ProviderCallError 就当断连」的老写法`,
      ).not.toMatch(/!\(e instanceof ProviderCallError\)/);
    }
  });
});

describe("耗时要分得开", () => {
  const CHAT = read("src/app/api/chat/route.ts");

  it("平台耗时、退避等待、上游耗时分开记", () => {
    // 只有一个 latencyMs 时,用户等了 200 秒,到底是我们装配慢、
    // 退避烧掉的、还是上游真在算,完全分不出来 —— 而三种修法完全不同
    for (const 段 of ["platformMs", "waitedMs", "firstTokenMs"]) {
      expect(CHAT, `缺少分段计时:${段}`).toContain(段);
    }
  });

  it("首字节从**发出上游调用**那一刻算,不是从请求进来算", () => {
    // 从请求进来算的话,我们自己的装配开销会被算进上游头上
    expect(CHAT).toMatch(/firstTokenMs \?\?= Date\.now\(\) - upstreamStartedAt/);
  });

  it("失败日志带上分段,能证明「一次上游都没跑」", () => {
    expect(CHAT).toMatch(/upstreamMs: upstreamStartedAt > 0/);
  });
});
