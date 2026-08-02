/**
 * 把工作区里的一个多文件前端工程,组装成一份能在浏览器里直接跑起来的页面。
 *
 * 为什么需要这个:智能体产出的往往是标准工程结构(index.html + src/*.jsx +
 * vite.config.js)。这套结构必须先 npm install 再构建才能运行,而工作区
 * 没有构建工具 —— 于是用户点开只能看到一堆代码,和把代码贴在对话气泡里
 * 没有区别。「产出了文件」和「看到了效果」是两回事,用户要的是后者。
 *
 * 做法是在 iframe 里现场编译:
 *   1. 把工作区当成虚拟文件系统塞进页面
 *   2. Babel standalone 现场把 JSX / TS 编译成标准 ES 模块
 *   3. 相对 import 解析到虚拟路径,每个模块生成一个 blob URL,
 *      再用 import map 把虚拟路径映射到 blob —— 这样即使模块之间
 *      互相引用也能正确连起来(先定虚拟路径再建 blob,避开了
 *      「要 URL 才能改写、要改写才能建 URL」的死循环)
 *   4. CSS 的 import 编译成一个注入 <style> 的模块
 *   5. 裸包名(react 等)走 esm.sh
 *
 * 这不是「假装能跑」:编译失败、模块缺失、CDN 拉不下来,都会在页面上
 * 如实写出原因,而不是留一个空白页让人以为是自己电脑的问题。
 */

/** 能参与编译的文本类型 */
const COMPILABLE = /\.(jsx|tsx|ts|js|mjs|css)$/i;

export interface BundleInput {
  readonly path: string;
  readonly content: string;
}

export interface BundleResult {
  /** 可直接塞进 iframe srcdoc,或存成 .html 双击打开 */
  readonly html: string;
  /** 入口模块的工作区路径;找不到时为 null */
  readonly entryModule: string | null;
}

/** 从 HTML 里找出 <script type="module" src="..."> 指向的入口 */
export function findEntryModule(
  html: string,
  allPaths: readonly string[],
): string | null {
  const re = /<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1];
    if (raw === undefined) continue;
    if (/^(https?:)?\/\//.test(raw)) continue; // CDN 脚本不是入口
    const normalized = normalizePath(raw);
    const hit = allPaths.find((p) => p === normalized);
    if (hit) return hit;
    // 扩展名省略或换过(src="/src/main.js" 实际文件是 main.jsx)
    const guess = allPaths.find((p) => stripExt(p) === stripExt(normalized));
    if (guess) return guess;
  }
  return null;
}

function stripExt(p: string): string {
  return p.replace(/\.[^./]+$/, "");
}

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** 安全地把值嵌进 <script> —— `</script>` 出现在字符串里会提前闭合标签 */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * 去掉原 HTML 里指向工作区本地文件的 script / link。
 *
 * 它们的路径在 iframe 里解析不到(srcdoc 没有基地址),留着只会产生
 * 一串 404。页面骨架(比如 <div id="root">)必须保留 —— 那是挂载点。
 */
function stripLocalRefs(html: string): string {
  return html
    .replace(/<script\b[^>]*\bsrc=["'](?!https?:|\/\/)[^"']*["'][^>]*>\s*<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref=["'](?!https?:|\/\/)[^"']*["'][^>]*>/gi, "");
}

/**
 * 组装可运行页面。
 *
 * @param entryHtml 入口 HTML 的内容
 * @param files 整个工作区的文件
 */
export function buildProjectPreview(
  entryHtml: string,
  files: readonly BundleInput[],
): BundleResult {
  const allPaths = files.map((f) => f.path);
  const entryModule = findEntryModule(entryHtml, allPaths);

  const vfs: Record<string, string> = {};
  for (const f of files) {
    if (COMPILABLE.test(f.path)) vfs[f.path] = f.content;
  }

  const skeleton = stripLocalRefs(entryHtml);
  const loader = LOADER.replace("__VFS__", embed(vfs)).replace(
    "__ENTRY__",
    embed(entryModule),
  );

  const injected = `<div id="__zy_status" style="font:13px/1.6 system-ui,sans-serif;padding:12px;color:#666">正在编译工作区文件…</div><script>${loader}</script>`;

  const html = /<\/body>/i.test(skeleton)
    ? skeleton.replace(/<\/body>/i, `${injected}</body>`)
    : `${skeleton}${injected}`;

  return { html, entryModule };
}

/**
 * iframe 内运行的加载器。
 *
 * 写成字符串而不是单独文件,是因为它必须整段嵌进 srcdoc —— iframe 用的是
 * 不透明源(sandbox 不给 allow-same-origin),取不到我们站点的任何资源。
 * blob 也必须在 iframe 内部创建,父页面创建的 blob 对它是跨源的。
 */
const LOADER = `
(function () {
  var FILES = __VFS__;
  var ENTRY = __ENTRY__;
  // 虚拟路径前缀必须是**裸标识符**的形式(不以 / . 开头,也不含 scheme)。
  //
  // 用过 "/__zy__/" 这种路径形式,结果是模块一律加载失败:路径型标识符
  // 要先按导入方的基地址解析成 URL 再查映射表,而导入方是 blob: URL,
  // blob 的 scheme 不是分层的,解析在第一步就报
  // "Invalid relative url or base scheme isn't hierarchical",
  // 根本走不到映射表。裸标识符不做 URL 解析,直接查表。
  var VP = "@zy/";

  // 提示框不能提前删掉 —— 入口模块是异步执行的,删了以后它抛的错
  // 就没地方显示,页面只剩一片空白,用户根本不知道发生了什么。
  // 改成用时再建。
  function say(msg, isError) {
    var box = document.getElementById("__zy_status");
    if (!box) {
      box = document.createElement("div");
      box.id = "__zy_status";
      box.style.cssText =
        "font:13px/1.6 system-ui,sans-serif;padding:12px;white-space:pre-wrap";
      document.body.insertBefore(box, document.body.firstChild);
    }
    box.style.color = isError ? "#b42318" : "#666";
    box.textContent = msg;
  }
  window.addEventListener("error", function (e) {
    say("运行出错:" + (e.message || "未知错误"), true);
  });

  function normalize(p) {
    var out = [], segs = p.split("/");
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === "" || s === ".") continue;
      if (s === "..") out.pop(); else out.push(s);
    }
    return out.join("/");
  }

  var EXTS = ["", ".jsx", ".tsx", ".js", ".ts", ".mjs", ".css"];
  function resolve(from, spec) {
    var base = from.split("/").slice(0, -1).join("/");
    var joined = normalize(spec.charAt(0) === "/" ? spec : base + "/" + spec);
    for (var i = 0; i < EXTS.length; i++) {
      if (FILES[joined + EXTS[i]] != null) return joined + EXTS[i];
    }
    for (var j = 1; j < EXTS.length; j++) {
      if (FILES[joined + "/index" + EXTS[j]] != null) return joined + "/index" + EXTS[j];
    }
    return null;
  }

  // 裸包名走 esm.sh。
  //
  // react 与 react-dom 必须落在同一个版本上,否则页面里会出现两份 React,
  // hooks 立刻报 "Invalid hook call"。所以两边都显式钉住同一个大版本,
  // 并用 esm.sh 的 ?deps 让 react-dom 复用同一份 react。
  // 只钉 react-dom 而放任 react 走 latest 是不够的 —— 那仍是两个 URL。
  var REACT = "19";
  function cdn(spec) {
    if (spec === "react" || spec.indexOf("react/") === 0) {
      return "https://esm.sh/react@" + REACT + spec.slice(5);
    }
    if (spec === "react-dom" || spec.indexOf("react-dom/") === 0) {
      return "https://esm.sh/react-dom@" + REACT + spec.slice(9) +
        "?deps=react@" + REACT;
    }
    return "https://esm.sh/" + spec;
  }

  var missing = [];
  function rewrite(code, from) {
    return code.replace(
      /(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])([^"']+)\\2/g,
      function (m, pre, q, spec) {
        if (/^(https?:|data:|blob:)/.test(spec)) return m;
        if (spec.charAt(0) === "." || spec.charAt(0) === "/") {
          var t = resolve(from, spec);
          if (!t) { missing.push(spec + "(来自 " + from + ")"); return m; }
          return pre + q + VP + t + q;
        }
        return pre + q + cdn(spec) + q;
      }
    );
  }

  function moduleFor(path) {
    var src = FILES[path];
    if (/\\.css$/i.test(path)) {
      return "var s=document.createElement('style');s.textContent=" +
        JSON.stringify(src) + ";document.head.appendChild(s);export default {};";
    }
    var presets = [["react", { runtime: "automatic" }]];
    if (/\\.tsx?$/i.test(path)) presets.push(["typescript", { isTSX: true, allExtensions: true }]);
    var out = Babel.transform(src, {
      presets: presets, filename: path, sourceType: "module"
    }).code;
    return rewrite(out, path);
  }

  function boot() {
    if (!ENTRY) {
      say("这个工程没有可识别的入口模块(index.html 里找不到指向工作区文件的 <script type=\\"module\\">),无法预览。", true);
      return;
    }
    var map = { imports: {} };
    for (var path in FILES) {
      try {
        var code = moduleFor(path);
      } catch (e) {
        say("编译 " + path + " 失败:" + (e && e.message ? e.message : e), true);
        return;
      }
      map.imports[VP + path] = URL.createObjectURL(
        new Blob([code], { type: "text/javascript" })
      );
    }

    var im = document.createElement("script");
    im.type = "importmap";
    im.textContent = JSON.stringify(map);
    document.head.appendChild(im);

    var entryUrl = map.imports[VP + ENTRY];
    if (!entryUrl) { say("找不到入口模块 " + ENTRY + "。", true); return; }

    var s = document.createElement("script");
    s.type = "module";
    s.src = entryUrl;
    s.onerror = function () { say("入口模块加载失败。", true); };
    document.body.appendChild(s);

    if (missing.length > 0) {
      say("以下 import 在工作区里找不到对应文件,页面可能不完整:\\n" + missing.join("\\n"), true);
    } else {
      var b0 = document.getElementById("__zy_status");
      if (b0) b0.remove();
    }
  }

  var b = document.createElement("script");
  b.src = "https://unpkg.com/@babel/standalone@7/babel.min.js";
  b.onload = boot;
  b.onerror = function () {
    say("无法加载编译器(unpkg.com)。预览需要联网,离线时只能看源码。", true);
  };
  document.head.appendChild(b);
})();
`;
