import { describe, expect, it } from "vitest";

import { decidePreview, pickDefaultFile } from "@/lib/workspace/preview";
import { buildProjectPreview, findEntryModule } from "@/lib/workspace/bundle";
import { renderMarkdown } from "@/lib/workspace/markdown";

/**
 * 预览能力判定与组装测试。
 *
 * 用户的原话:「文件无法呈现成视觉效果,是一堆代码」「工作区没有渲染」。
 * 产出文件和看到效果是两回事 —— 一堆代码摆在那里,和贴在对话气泡里
 * 没有本质区别。
 *
 * 但边界必须诚实:给一个渲染不出来的空白预览,比明说「这个看不了、
 * 为什么看不了」更糟 —— 用户会以为是自己电脑坏了。
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

  it("引用工作区模块的 HTML 走工程预览,而不是拒绝", () => {
    // 智能体实际产出的就是这种:index.html + src/main.jsx 的 Vite 结构。
    // 以前判定为「需要构建、不能预览」,用户只能看代码。
    const r = decidePreview(
      "index.html",
      '<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>',
      ["index.html", "src/main.jsx"],
    );
    expect(r.kind).toBe("project");
    expect(r.reason).toBeNull();
  });

  it("Markdown 渲染成文档", () => {
    expect(decidePreview("README.md", "# 标题", ["README.md"]).kind).toBe(
      "markdown",
    );
  });

  it("SVG 直接画出来", () => {
    expect(decidePreview("logo.svg", "<svg/>", ["logo.svg"]).kind).toBe("svg");
  });

  it("组件源码没有独立效果,但要指出去哪儿看整体效果", () => {
    const r = decidePreview("src/App.jsx", "export default () => null;", [
      "index.html",
      "src/App.jsx",
    ]);
    expect(r.kind).toBe("none");
    expect(r.reason).toContain("index.html");
  });

  it("工作区没有 HTML 入口时如实说明,不含糊其辞", () => {
    const r = decidePreview("src/App.jsx", "export default () => null;", [
      "src/App.jsx",
    ]);
    expect(r.kind).toBe("none");
    expect(r.reason).toContain("没有 HTML 入口");
  });
});

describe("默认打开的文件", () => {
  it("优先落在 index.html,而不是字母序第一个", () => {
    // 用户截图里默认选中的是 README.md —— 第一眼看到文档而不是成品
    expect(pickDefaultFile(["README.md", "index.html", "src/App.jsx"])).toBe(
      "index.html",
    );
  });

  it("没有 HTML 时退回 README", () => {
    expect(pickDefaultFile(["src/App.jsx", "README.md"])).toBe("README.md");
  });

  it("空工作区返回 null", () => {
    expect(pickDefaultFile([])).toBeNull();
  });
});

describe("工程预览组装", () => {
  const files = [
    {
      path: "index.html",
      content:
        '<!doctype html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>',
    },
    { path: "src/main.jsx", content: 'import App from "./App.jsx";' },
    { path: "src/App.jsx", content: "export default () => null;" },
    { path: "src/App.css", content: ".a{color:red}" },
  ];

  it("找得到入口模块", () => {
    expect(findEntryModule(files[0]!.content, files.map((f) => f.path))).toBe(
      "src/main.jsx",
    );
  });

  it("入口 src 省略了扩展名也能对上", () => {
    expect(
      findEntryModule('<script type="module" src="/src/main.js"></script>', [
        "src/main.jsx",
      ]),
    ).toBe("src/main.jsx");
  });

  it("组装出的页面保留挂载点,并去掉解析不到的本地 script", () => {
    const { html, entryModule } = buildProjectPreview(files[0]!.content, files);
    expect(entryModule).toBe("src/main.jsx");
    expect(html).toContain('<div id="root">');
    // 原来的本地 script 必须去掉,否则 iframe 里是一串 404
    expect(html).not.toContain('src="/src/main.jsx"');
  });

  it("把工作区文件都带进页面,包括 CSS", () => {
    const { html } = buildProjectPreview(files[0]!.content, files);
    expect(html).toContain("src/App.jsx");
    expect(html).toContain("src/App.css");
  });

  it("文件内容里的 </script> 不会提前闭合标签", () => {
    const evil = [
      {
        path: "index.html",
        content: '<body><script src="./a.js"></script></body>',
      },
      { path: "a.js", content: 'var x = "</script><img onerror=alert(1)>";' },
    ];
    const { html } = buildProjectPreview(evil[0]!.content, evil);
    expect(html).not.toContain("</script><img");
  });

  it("没有入口模块时不假装能跑", () => {
    const { html, entryModule } = buildProjectPreview(
      "<body><div id=root></div></body>",
      [{ path: "index.html", content: "<body></body>" }],
    );
    expect(entryModule).toBeNull();
    expect(html).toContain("无法预览");
  });
});

describe("Markdown 渲染", () => {
  it("标题、列表、行内代码", () => {
    const html = renderMarkdown("# 标题\n\n- 一\n- 二\n\n用 `npm` 安装");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<li>一</li>");
    expect(html).toContain("<code>npm</code>");
  });

  it("代码块整块保留,不当成列表解析", () => {
    const html = renderMarkdown("```\n- 这不是列表\n```");
    expect(html).toContain("<pre><code>- 这不是列表</code></pre>");
  });

  it("代码里的星号不会被当成粗体", () => {
    expect(renderMarkdown("`a **b** c`")).not.toContain("<strong>");
  });

  it("转义 HTML —— 内容是模型生成的,当不可信输入", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("只放行 http(s) 链接", () => {
    expect(renderMarkdown("[点](javascript:alert(1))")).not.toContain("href");
    expect(renderMarkdown("[点](https://a.com)")).toContain(
      'href="https://a.com"',
    );
  });
});
