import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「谁有权把模型变成不可选」的策略一致性检查。
 *
 * 真实故障:用户手动恢复了 moonshotai/kimi-k2.6(他实测已可用),
 * 点了一次「测试连接」后又变回不可选;deepseek-coder-6.7b 删掉后也被导回来。
 * 用户的原话是「系统自己把我的设置改了」。
 *
 * 根因不是判断逻辑错,而是**同一条策略我只改了一半**:
 * 对话路由(api/chat)已经改成「失败只记 last_error,不动可选状态」,
 * 而测试连接(settings/models/actions)仍在写 chat_unavailable_reason ——
 * 那一列的含义就是「不可选」。两条路径对同一件事有两套规矩。
 *
 * 这类不一致靠读代码很难发现(两个文件相隔很远),但用一条断言就能钉死:
 * **除了用户主动操作,任何地方都不许写 chat_unavailable_reason 的非空值。**
 */

const ROOT = resolve(__dirname, "../..");

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** 去掉注释,避免把说明文字里的字眼误判成代码 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const WRITE_PATHS = [
  "src/app/(app)/settings/models/actions.ts",
  "src/app/api/chat/route.ts",
];

describe("模型可用性策略", () => {
  it("系统路径不得把模型写成不可选,只能写 null", () => {
    for (const path of WRITE_PATHS) {
      const code = stripComments(read(path));
      // 允许 chat_unavailable_reason: null(恢复可选),
      // 也允许 .is("chat_unavailable_reason", null) 这类读取条件;
      // 但不允许写入任何非 null 的值。
      const writes = [
        ...code.matchAll(/chat_unavailable_reason:\s*([^,\n]+)/g),
      ].map((m) => m[1]!.trim());

      for (const value of writes) {
        expect(
          value,
          `${path} 里把模型写成了不可选(${value})。` +
            `只有用户主动删除才能改变模型的去留,系统失败只能记 last_error。`,
        ).toBe("null");
      }
    }
  });

  it("测试连接对失败模型记的是 last_error", () => {
    const code = stripComments(read("src/app/(app)/settings/models/actions.ts"));
    expect(code).toContain("last_error");
  });

  it("用户删除模型时会写入排除记录,否则重新导入会把它带回来", () => {
    const code = stripComments(read("src/app/(app)/settings/models/actions.ts"));
    // 上一次就是排除没写进去,导致「删了又回来」
    expect(code).toContain("ai_model_exclusions");
  });

  it("导入时会跳过被排除的模型", () => {
    const code = stripComments(read("src/app/(app)/settings/models/actions.ts"));
    expect(code).toMatch(/excluded\.has\(/);
  });
});
