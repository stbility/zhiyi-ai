import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * 平台免费档:让新注册用户「注册完直接能对话」。
 *
 * 此前的真实状态:注册成功 → 有了组织 → 组织下**一个模型都没有** →
 * 助手页是空的。这条验收标准从来没有成立过。
 *
 * 【为什么另起一张表,不复用 ai_providers / ai_models】
 * 那两张表按组织存(organization_id NOT NULL),存的是用户自己的 BYOK
 * 密钥(api_key_cipher NOT NULL)。要让它们承载平台级共享模型,就得把
 * 这两列改成可空 —— 而它们正是 RLS 策略与列级 GRANT 的依据,
 * 改了要重写全部策略,爆炸半径远大于收益。
 */

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/0026_platform_models.sql");
const POOL = read("src/lib/ai/platform-models.ts");

const { platformProviderId, isPlatformProviderId } = await import(
  "@/lib/ai/platform-models"
);

describe("密钥不进代码库、不进数据库", () => {
  it("表里只存环境变量的名字,不存密钥本身", () => {
    expect(MIGRATION).toMatch(/api_key_env\s+text not null/);
    expect(MIGRATION, "表里出现了密钥列").not.toMatch(
      /api_key(_cipher)?\s+text/,
    );
  });

  it("种子数据里没有任何真实密钥的形状", () => {
    // sk-、nvapi-、ghp_ 这类前缀一旦出现在迁移里就是灾难 ——
    // 迁移文件是要提交进仓库的
    expect(MIGRATION).not.toMatch(/sk-[A-Za-z0-9]{10,}|nvapi-[A-Za-z0-9]{10,}/);
  });

  it("密钥从环境变量读,读不到就跳过该模型", () => {
    expect(POOL).toMatch(/process\.env\[row\.api_key_env\]/);
    expect(POOL).toMatch(/缺密钥/);
  });

  it("跳过时记一条 warn,不静默", () => {
    // 静默跳过会让「免费档为什么是空的」变成一个查不出原因的现象
    expect(POOL).toMatch(/对应的环境变量没配置,已跳过/);
  });
});

describe("免费档隔离:默认拒绝,不是默认放行", () => {
  it("free_only 默认 true", () => {
    // 反过来的话,任何一次漏写都会让新组织直接拿到付费模型。
    // 默认值要选**出错时代价小**的那个。
    expect(MIGRATION).toMatch(/free_only boolean not null default true/);
  });

  it("过滤用 eq('free') 而不是 neq('paid')", () => {
    // 以后加了第三档(比如 trial),neq 会把它悄悄放行给免费用户,
    // 而 eq 会把它挡在外面
    expect(POOL).toMatch(/query\.eq\("tier", "free"\)/);
    expect(POOL, "用了 neq —— 新增档位会被悄悄放行").not.toMatch(/\.neq\(/);
  });

  it("读不到组织档位时按免费档处理", () => {
    // 少给几个模型,好过把付费模型送给一个档位未知的组织
    for (const f of [
      "src/lib/ai/candidates.ts",
      "src/lib/db/conversations.ts",
      "src/lib/ai/turn-preflight.ts",
    ]) {
      expect(read(f), `${f} 的默认档位取错了方向`).toMatch(
        /free_only !== false/,
      );
    }
  });

  it("档位判定只有一处实现", () => {
    // 分散到每个调用方去过滤,漏一处就是免费用户白嫖付费模型,
    // 而且漏了不会报错
    expect(POOL).toMatch(/免费档隔离的\*\*唯一\*\*实现点/);
  });
});

describe("平台模型不能靠客户端传的标识就放行", () => {
  /**
   * providerId 是客户端传上来的。它长得像平台标识**不构成授权** ——
   * 必须落到 loadPlatformCandidates 的返回列表里才算数,
   * 而那个列表是按 free_only 过滤过的。
   */
  it("入口检查里重新跑一遍候选,不是只看前缀", () => {
    const PRE = read("src/lib/ai/turn-preflight.ts");
    expect(PRE).toContain("loadPlatformCandidates");
    expect(PRE).toMatch(/list\.find\(/);
    expect(PRE).toMatch(/不构成授权/);
  });

  it("对话路由同样重跑,不复用客户端说法", () => {
    const CHAT = read("src/app/api/chat/route.ts");
    expect(CHAT).toContain("loadPlatformCandidates");
  });

  it("表上没有任何 insert/update 策略", () => {
    // 少写一条写策略,就少一条「用户把自己的模型塞进平台池」的路
    expect(MIGRATION).not.toMatch(/for insert|for update|for all/i);
    expect(MIGRATION).toMatch(/for select to authenticated/);
  });
});

describe("伪 providerId 的形状", () => {
  it("按服务商分组,不是全部归一", () => {
    // 共用一个 providerId 的话,降级会把不同服务商当成同一家,
    // 又回到「换了等于没换」—— 那正是把产品打死过的那个缺陷
    const a = platformProviderId("openai_compatible", "https://a.example/v1");
    const b = platformProviderId("openai_compatible", "https://b.example/v1");
    expect(a).not.toBe(b);
  });

  it("一眼可辨,且不会与真实 uuid 相撞", () => {
    const id = platformProviderId("openai_compatible", "https://a.example/v1");
    expect(isPlatformProviderId(id)).toBe(true);
    expect(
      isPlatformProviderId("3f2a1b4c-5d6e-4f70-8912-abcdef012345"),
      "真实 uuid 被误判成平台标识",
    ).toBe(false);
  });
});

describe("密钥不下发浏览器", () => {
  it("选择器返回值逐字段挑,不整个对象展开", () => {
    // loadPlatformCandidates 返回的对象里带着 apiKeyCipher,
    // 而 loadModels 的返回值会被序列化下发到浏览器
    const CONV = read("src/lib/db/conversations.ts");
    expect(CONV, "把候选对象整个展开了 —— 密文会跟着下发").not.toMatch(
      /\.\.\.c[,\s}]/,
    );
    expect(CONV).toMatch(/providerId: c\.providerId/);
  });
});
