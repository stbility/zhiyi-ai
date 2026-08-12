import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * readRepoFile 读缓存契约(方案 A,2026-08-12)。
 *
 * 守的契约:
 *   1. 缓存 key 含 installationId + owner/repo + ref + path —— 互不污染
 *   2. TTL 60s:过期后重新请求
 *   3. 只缓存成功结果;失败路径不写缓存
 *   4. 缓存有上限(200 条),防无限增长
 */

const SRC = readFileSync(
  resolve(__dirname, "../../src/lib/integrations/github.ts"),
  "utf8",
);

describe("readRepoFile 读缓存", () => {
  it("缓存 key 含仓库/分支/文件全维度(互不污染)", () => {
    expect(SRC).toMatch(/cacheKey/);
    expect(SRC).toMatch(/\$\{installationId\}\|/);
    expect(SRC).toMatch(/\$\{ref\.owner\}\/\$\{ref\.repo\}/);
    expect(SRC).toMatch(/ref\.ref \?\? ""/);
    expect(SRC).toMatch(/\$\{path\}/);
  });

  it("TTL 60s(过期后重新请求)", () => {
    expect(SRC).toMatch(/FILE_CACHE_TTL_MS = 60_000/);
    expect(SRC).toMatch(/Date\.now\(\) - hit\.at < FILE_CACHE_TTL_MS/);
  });

  it("只缓存成功结果,失败不写缓存", () => {
    // 成功路径(文件内容解析后)才 set
    expect(SRC).toMatch(/fileCache\.set\(key, \{ at: Date\.now\(\), result \}\)/);
    // 失败分支(404/目录/非文件)直接 return,不经过 set
    expect(SRC).toMatch(/if \(r\.status === 404\) return \{ ok: false/);
  });

  it("缓存上限 200 条,超限清最旧", () => {
    expect(SRC).toMatch(/fileCache\.size > 200/);
    expect(SRC).toMatch(/oldestKey/);
    expect(SRC).toMatch(/fileCache\.delete\(oldestKey\)/);
  });
});
