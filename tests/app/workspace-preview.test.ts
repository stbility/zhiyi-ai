import { describe, expect, it } from "vitest";

import { decidePreview } from "@/lib/workspace/preview";

/**
 * 预览能力判定测试。
 *
 * 用户的原话:「文件无法宣传成视觉效果,是一堆代码」。
 * 产出文件和看到效果是两回事 —— 一堆代码摆在那里,和贴在对话气泡里
 * 没有本质区别。
 *
 * 但边界必须诚实:给一个渲染不出来的空白预览,比明说「这需要构建」更糟 ——
 * 用户会以为是系统坏了。
 */

describe("预览判定", () => {
  it("单文件 HTML 可以直接预览", () => {
    const r = decidePreview(
      "index.html",
      "<!DOCTYPE html><body><h1>你好</h1></body>",
      ["index.html"],
    );
    expect(r.kind).toBe("html");
    expect(r.reason).toBeNull();
  });

  it("引用了裸 JSX 的 HTML 不给假预览,而是说明原因", () => {
    // 这正是用户遇到的:index.html 里 <script src="/src/index.jsx">
    // 浏览器解析不了 JSX,预览出来必然空白
    const r = decidePreview(
      "index.html",
      '<body><div id="root"></div><script type="module" src="/src/index.jsx"></script></body>',
      ["index.html", "src/index.jsx"],
    );
    expect(r.kind).toBe("none");
    expect(r.reason).toContain("构建");
    // 要给出可执行的下一步,而不是只说不行
    expect(r.reason).toContain("单文件 HTML");
    expect(r.reason).toContain("src/index.jsx");
  });

  it("源码文件说明需要构建", () => {
    const r = decidePreview("src/App.tsx", "export default () => null;", []);
    expect(r.kind).toBe("none");
    expect(r.reason).toContain("构建");
  });

  it("其它类型如实说没有预览", () => {
    const r = decidePreview("data.json", "{}", []);
    expect(r.kind).toBe("none");
    expect(r.reason).toContain("没有可视化预览");
  });
});
