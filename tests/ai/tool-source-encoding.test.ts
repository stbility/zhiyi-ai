import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * 工具定义源码不得含裸控制字符。
 *
 * 起因很具体:tools.ts 里的路径校验原本写成 /[<0x00>-<0x1f>]/ —— 把 0x00
 * 和 0x1f 两个字节**字面**打进了源码。行为是对的,但 git 因此把整个文件
 * 判定为二进制:每次改动都只显示 `Bin 9402 -> 10162 bytes`,看不到 diff。
 *
 * 后果不是美观问题。tools.ts 是整个项目最需要被逐行审查的文件 ——
 * 模型能调哪些工具、路径怎么校验、能不能穿越出工作区,全在这里。
 * 一个 diff 不可见的安全边界文件,等于这道边界的每次改动都没人复核。
 *
 * 语义完全不变:改用 \u0000-\u001f 转义,匹配的还是同一批字符。
 */

const SOURCES = [
  "src/lib/ai/tools.ts",
  "src/lib/ai/git-tools.ts",
  "src/lib/ai/agent.ts",
  "src/lib/ai/gateway.ts",
];

/** 制表符与换行是正常的排版字符,不在此列 */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

describe("工具定义源码的编码", () => {
  for (const relative of SOURCES) {
    it(`${relative} 不含裸控制字符(否则 git 当二进制,diff 不可见)`, () => {
      const text = readFileSync(join(process.cwd(), relative), "utf8");
      const at = text.search(FORBIDDEN);
      expect(
        at,
        at === -1
          ? ""
          : `第 ${text.slice(0, at).split("\n").length} 行含裸控制字符,` +
              `请改用 \\u00XX 转义写法`,
      ).toBe(-1);
    });
  }
});

describe("改成转义写法之后,路径校验的行为不变", () => {
  it("含控制字符的路径仍然被拒绝", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { writeFileSchema } = await import("@/lib/ai/tools");

    // 用换行伪装成两行的路径,是最典型的一种注入尝试
    const bad = writeFileSchema.safeParse({
      path: "src/a\u0000b.ts",
      content: "x",
    });
    expect(bad.success).toBe(false);

    const alsoBad = writeFileSchema.safeParse({
      path: "src/a\u001fb.ts",
      content: "x",
    });
    expect(alsoBad.success).toBe(false);
  });

  it("正常路径仍然通过 —— 连字符、点号、多级目录都不能误伤", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { writeFileSchema } = await import("@/lib/ai/tools");

    for (const path of [
      "src/app/page.tsx",
      "src/components/todo-item.jsx",
      "README.md",
      "a/b/c/d.config.json",
    ]) {
      const r = writeFileSchema.safeParse({ path, content: "x" });
      expect(r.success, `${path} 不该被拒绝`).toBe(true);
    }
  });
});
