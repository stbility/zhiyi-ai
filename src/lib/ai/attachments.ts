/**
 * 文件夹附件的读取与筛选(浏览器侧)。
 *
 * 用途:做编程类工作时,把本地项目目录一次性带进对话,而不是一个文件一个文件地贴。
 *
 * 三条硬约束,都是为了不把对话搞垮:
 *   1. 只读文本。二进制(图片、压缩包、编译产物)塞进对话毫无意义,还会撑爆上下文。
 *   2. 跳过依赖与构建目录。node_modules 动辄上万文件,选中即卡死。
 *   3. 总量封顶。超出就停,并如实告诉用户「带了几个、跳过了几个」——
 *      悄悄截断会让模型看到残缺代码,给出的建议全是错的,比不带更糟。
 */

/** 单个附件 */
export interface Attachment {
  /** 相对路径,用于让模型知道文件在项目里的位置 */
  path: string;
  content: string;
}

export interface CollectResult {
  attachments: Attachment[];
  /** 被跳过的文件数与原因统计,用于如实告知 */
  skipped: {
    binary: number;
    ignored: number;
    tooLarge: number;
    overBudget: number;
  };
}

/**
 * 容量上限。
 *
 * 原来卡在 40 个文件,是我拍的数,真实项目动辄成百上千个文件,一选就被截断。
 * 现在不再人为限制文件个数,只保留两个**真实存在**的物理约束:
 *
 *   1. 请求体大小 —— Vercel 的 Serverless 函数请求体上限约 4.5MB,
 *      超了连不上服务端。中文按 UTF-8 最多 3 字节/字,留足余量后取 120 万字符。
 *   2. 模型上下文 —— 120 万字符大约 30–40 万 token。DeepSeek V4 与 GLM-5.2
 *      都是 100 万 token 上下文,装得下;换成小上下文的模型会由服务商报错,
 *      那时错误里会带明确说明。
 *
 * 单文件上限保留,但放宽到 40 万字符:超过这个量的单个文件基本是压缩产物、
 * 打包结果或数据集,读进去只会挤掉真正的源码。
 */
/** 文件个数不再限制 —— 由总字符数统一约束 */
export const MAX_FILES = Number.POSITIVE_INFINITY;
/** 单个文件最大字符数 —— 超过通常是压缩产物或数据文件 */
export const MAX_FILE_CHARS = 400_000;
/** 全部附件合计上限,由请求体大小反推 */
export const MAX_TOTAL_CHARS = 1_200_000;

/** 明确是文本、且对读代码有意义的扩展名 */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs",
  "php", "sh", "bash", "zsh", "sql", "graphql", "gql", "proto",
  "html", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "md", "mdx", "txt", "yml", "yaml", "toml", "ini", "conf", "env", "example",
  "gitignore", "dockerignore", "editorconfig", "lock",
]);

/** 依赖、构建产物、版本库内部目录 —— 选中即卡死,一律跳过 */
const IGNORED_SEGMENTS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "target",
  "vendor", "__pycache__", ".venv", "venv", ".turbo", "coverage",
  ".cache", ".idea", ".vscode", ".DS_Store",
]);

function isIgnored(path: string): boolean {
  return path.split("/").some((seg) => IGNORED_SEGMENTS.has(seg));
}

function isTextFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  // 无扩展名但常见的文本配置文件
  if (!name.includes(".")) {
    return ["Dockerfile", "Makefile", "LICENSE", "README"].includes(name);
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

/** 去掉浏览器给的最外层目录名,让路径更贴近项目内的相对路径 */
function normalizePath(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : relativePath;
}

/**
 * 把用户选中的目录读成附件列表。
 *
 * 只在浏览器里跑 —— 文件内容不上传到任何存储,只随本次请求发给模型。
 */
export async function collectFolderAttachments(
  files: readonly File[],
): Promise<CollectResult> {
  const skipped = { binary: 0, ignored: 0, tooLarge: 0, overBudget: 0 };
  const attachments: Attachment[] = [];
  let total = 0;

  // 路径排序,让模型看到的文件顺序稳定、可预期
  const sorted = [...files].sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(
      b.webkitRelativePath || b.name,
    ),
  );

  for (const file of sorted) {
    const raw = file.webkitRelativePath || file.name;

    if (isIgnored(raw)) {
      skipped.ignored += 1;
      continue;
    }
    if (!isTextFile(raw)) {
      skipped.binary += 1;
      continue;
    }
    if (file.size > MAX_FILE_CHARS) {
      skipped.tooLarge += 1;
      continue;
    }
    const text = await file.text();
    if (total + text.length > MAX_TOTAL_CHARS) {
      skipped.overBudget += 1;
      continue;
    }

    total += text.length;
    attachments.push({ path: normalizePath(raw), content: text });
  }

  return { attachments, skipped };
}

/** 把跳过情况说成一句人话 —— 不说清楚,用户会以为文件带全了 */
export function describeSkipped(skipped: CollectResult["skipped"]): string {
  const parts: string[] = [];
  if (skipped.ignored > 0) parts.push(`${skipped.ignored} 个依赖/构建文件`);
  if (skipped.binary > 0) parts.push(`${skipped.binary} 个非文本文件`);
  if (skipped.tooLarge > 0) parts.push(`${skipped.tooLarge} 个超大文件`);
  if (skipped.overBudget > 0) {
    parts.push(`${skipped.overBudget} 个因总量超出上限未带上`);
  }
  return parts.length === 0 ? "" : `已跳过 ${parts.join("、")}`;
}
