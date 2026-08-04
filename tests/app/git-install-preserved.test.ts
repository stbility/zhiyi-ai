import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 应用装上了就是装上了 —— 我们这边凭据坏掉,不能把这个事实丢掉。
 *
 * 用户的原话:「我的配置正确,已安装成功,集成卡片未触及连接」。
 *
 * 此前的处理是:换取安装令牌失败 → **什么都不写** → 直接带着报错返回。
 * 于是卡片一直显示「未连接」,而用户看着 GitHub 上明明装好的应用
 * (安装编号 151228033 是真实存在的),只能得出「这功能是坏的」。
 * 他没说错,但原因不是没装上,是我们这边的私钥换不到令牌。
 *
 * 这是两件事,必须分开:
 *   installation_id   GitHub 说的,客观事实
 *   credential_error  我们换令牌失败的原因,是我们的问题
 *
 * 分开之后凭据修好**不需要重装**——记录已经在库里了。
 */

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

const CALLBACK = read("src/app/api/integrations/github/callback/route.ts");
const CARD = read("src/components/app/GitConnection.tsx");
const PAGE = read("src/app/(app)/settings/integrations/page.tsx");

const 去注释 = (code: string) =>
  code.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

describe("换不到令牌也要把安装记下来", () => {
  it("upsert 不再挂在 auth.ok 之后", () => {
    const c = 去注释(CALLBACK);
    const 换令牌 = c.indexOf("getInstallationToken(installationId)");
    const 写库 = c.indexOf('from("git_installations").upsert');
    expect(换令牌).toBeGreaterThan(-1);
    expect(写库).toBeGreaterThan(-1);
    // 关键:两者之间不能有「失败就 return」把写库跳过去
    const 之间 = c.slice(换令牌, 写库);
    expect(
      之间,
      "换令牌失败仍然直接 return,安装记录又被丢掉了",
    ).not.toMatch(/if \(!auth\.ok\)[\s\S]*?return back/);
  });

  it("失败原因记进 credential_error,成功时清空", () => {
    expect(CALLBACK).toMatch(/credential_error: auth\.ok \? null : auth\.error/);
  });

  it("换不到令牌时不去猜账号名与授权范围", () => {
    // 那两个字段只能问 GitHub 要,而那也需要令牌。
    // 填一个猜的值比留空更糟 —— 字段名与内容对不上的数据是有害的。
    expect(CALLBACK).toMatch(/auth\.ok\s*\n?\s*\?\s*await getInstallation/);
  });
});

describe("卡片如实区分三种状态", () => {
  it("已安装但凭据坏 —— 既不显示「已连接」也不显示「未连接」", () => {
    const r = 去注释(CARD);
    expect(r).toMatch(/installation\?\.credentialError \?/);
    expect(r).toMatch(/已安装 · 凭据待修复/);
  });

  it("顺序正确:凭据坏要排在「已连接」之前判", () => {
    // 顺序反了的话,装上但凭据坏会被判成「已连接」——
    // 那比显示「未连接」更糟,用户会以为仓库工具能用
    const r = 去注释(CARD);
    const 坏 = r.indexOf("installation?.credentialError ?");
    const 连 = r.indexOf('tone="success">已连接');
    expect(坏).toBeGreaterThan(-1);
    expect(连).toBeGreaterThan(坏);
  });

  it("页面把这一列读出来传给卡片", () => {
    expect(PAGE).toMatch(/credential_error/);
    expect(PAGE).toMatch(/credentialError:/);
  });

  it("明说不需要重装 —— 否则用户会反复重装", () => {
    // 重装多少次都一样,坏的根本不是安装
    expect(去注释(CARD)).toMatch(/不需要重装/);
  });
});
