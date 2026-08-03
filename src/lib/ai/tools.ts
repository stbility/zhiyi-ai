/**
 * 智能体工具定义。
 *
 * 这是「智能体」和「聊天助手」的分界线:聊天助手只能说,智能体能做。
 * 模型通过工具调用改变世界 —— 写文件、读文件、列目录 —— 而不是把代码
 * 吐在气泡里等人复制。
 *
 * 声明格式用 OpenAI 的 tools 规范。它是事实标准,DeepSeek、智谱、
 * Moonshot、英伟达的兼容接口都认这一套 —— 与具体厂商无关,
 * 换模型不必改工具。
 *
 * 工具的执行全在服务端。模型只能请求调用,不能自己执行 ——
 * 这是安全边界:模型的输出永远是不可信输入,参数必须校验。
 */

import { z } from "zod";

/** OpenAI tools 规范里的一条工具声明 */
export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** 模型请求的一次工具调用 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 原始 JSON 字符串 —— 模型可能给出非法 JSON,解析失败要如实回报 */
  readonly rawArguments: string;
}

/** 一次工具执行的结果,回喂给模型 */
export interface ToolResult {
  readonly callId: string;
  readonly name: string;
  /** 给模型看的文本。成功失败都要说清楚,失败也是有用的观察 */
  readonly content: string;
  readonly ok: boolean;
}

/**
 * 文件路径校验。
 *
 * 模型的输出是不可信输入。没有这道校验,一句 `write_file("../../etc/passwd")`
 * 就能写到工作区之外 —— 虽然我们存的是数据库不是磁盘,但路径穿越会让
 * 不同工作区互相污染,同样是越权。
 */
const pathSchema = z
  .string()
  .trim()
  .min(1, "路径不能为空")
  .max(400, "路径过长")
  // 开头的 `/` 规范化掉,不当错误。
  //
  // 我们的路径是数据库里的键,不是磁盘路径 —— `/index.html` 和
  // `index.html` 本来就该是同一个文件,拒绝前者没有任何安全收益。
  // 而它的代价是实打实的:一次真实运行里,模型 list_files 看到空工作区、
  // 接着用 `/index.html` 去 read_file,撞上「路径必须是相对路径」,
  // 然后把 285 秒预算耗光,工作区一个文件都没有。
  //
  // 真正要防的是路径穿越,那由下面的 `..` 那条守着,一步没松。
  .transform((p) => p.replace(/^\/+/, ""))
  .refine((p) => p.length > 0, "路径不能只有斜杠")
  .refine((p) => !p.split("/").includes(".."), "路径不能包含 ..")
  .refine((p) => !/[\u0000-\u001f]/.test(p), "路径含非法字符");

export const writeFileSchema = z.object({
  path: pathSchema,
  content: z.string().max(400_000, "单个文件过大"),
});

export const readFileSchema = z.object({ path: pathSchema });

export const listFilesSchema = z.object({
  /** 只列这个前缀下的文件,留空列全部 */
  prefix: z.string().trim().max(400).optional(),
});

/**
 * 把参数校验失败说成模型能照着改的话。
 *
 * 只回一句「参数不合法:路径必须是相对路径」是不够的 —— 模型不知道
 * 是哪个参数、当时传的是什么,于是它下一步很可能原样再试一次,
 * 而每试一次都在烧本次运行的预算。真实后果:一次运行就这么耗光了,
 * 工作区一个文件都没写出来。
 *
 * 所以把出错的字段名和它当时收到的值一起回去。
 */
function describeBadArgs(error: z.ZodError, args: unknown): string {
  const issue = error.issues[0];
  const field = issue?.path.join(".") ?? "";
  const got = (args as Record<string, unknown> | null)?.[field];
  const 实收 =
    typeof got === "string"
      ? `,收到的是「${got.slice(0, 120)}」`
      : got === undefined
        ? ",这个参数没有传"
        : "";
  return `参数 ${field || "(未知)"} 不合法:${issue?.message ?? "未知"}${实收}。请修正后重新调用。`;
}

/**
 * 工具声明。
 *
 * description 写得具体一些 —— 模型靠它判断什么时候该调。写得含糊,
 * 模型要么不调(继续把代码吐在正文里),要么乱调。
 */
export const FILE_TOOLS: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "把文件写入工作区。产出代码、配置、文档时必须用这个工具,不要把文件内容写在回答正文里。" +
        "同一路径重复写入即覆盖。路径用项目内的相对路径,例如 src/app/page.tsx。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对路径" },
          content: { type: "string", description: "文件完整内容" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取工作区里已有的文件。修改任何文件之前都应当先读一遍确认现状,不要凭记忆改。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对路径" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "列出工作区里已有的文件路径与大小。开始工作前先看一眼有什么,避免重复创建或覆盖不该动的文件。",
      parameters: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description: "只列这个前缀下的文件,留空列全部",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/** 工具执行需要的上下文 —— 由调用方注入,工具本身不认识数据库 */
export interface ToolContext {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(prefix: string | undefined): Promise<
    readonly { path: string; sizeChars: number }[]
  >;
}

/**
 * 执行一次工具调用。
 *
 * 永不抛错 —— 工具失败是模型需要知道的**观察结果**,不是系统故障。
 * 把失败原因如实回喂,模型才能改正(比如路径写错了就换一个)。
 * 抛错只会让整轮中断,模型什么都学不到。
 */
export async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({
    callId: call.id,
    name: call.name,
    content,
    ok: false,
  });

  let args: unknown;
  try {
    args = JSON.parse(call.rawArguments === "" ? "{}" : call.rawArguments);
  } catch {
    return fail("参数不是合法的 JSON,请重新生成这次调用。");
  }

  try {
    switch (call.name) {
      case "write_file": {
        const parsed = writeFileSchema.safeParse(args);
        if (!parsed.success) {
          return fail(describeBadArgs(parsed.error, args));
        }
        await ctx.writeFile(parsed.data.path, parsed.data.content);
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: `已写入 ${parsed.data.path}(${parsed.data.content.length} 字符)。`,
        };
      }

      case "read_file": {
        const parsed = readFileSchema.safeParse(args);
        if (!parsed.success) {
          return fail(describeBadArgs(parsed.error, args));
        }
        const content = await ctx.readFile(parsed.data.path);
        if (content === null) {
          // 「文件不存在」是正常观察,不是错误 —— 模型据此决定新建
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: `文件 ${parsed.data.path} 不存在。`,
          };
        }
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: `${parsed.data.path} 的内容:\n\n${content}`,
        };
      }

      case "list_files": {
        const parsed = listFilesSchema.safeParse(args);
        if (!parsed.success) {
          return fail(describeBadArgs(parsed.error, args));
        }
        const files = await ctx.listFiles(parsed.data.prefix);
        if (files.length === 0) {
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content: "工作区当前没有文件。",
          };
        }
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content:
            `工作区共 ${files.length} 个文件:\n` +
            files.map((f) => `${f.path}(${f.sizeChars} 字符)`).join("\n"),
        };
      }

      default:
        return fail(`未知的工具:${call.name}`);
    }
  } catch (e) {
    return fail(
      `执行失败:${e instanceof Error ? e.message : "未知错误"}`,
    );
  }
}

/**
 * 给智能体的系统提示。
 *
 * 必须明确「代码要写进文件」——否则模型的默认行为是把代码贴在正文里,
 * 那正是我们要解决的问题。模型不会自己意识到有工作区这回事。
 */
export const AGENT_SYSTEM_PROMPT = `你是一个能直接操作工作区文件的智能体。

**最重要的一条:任何产物都必须用 write_file 写进工作区,绝不允许把
文件内容贴在回答正文里。** 这是智能体与聊天助手的分界线 ——
贴在正文里的代码,用户还要手工复制粘贴,那等于没做。
哪怕只产出一个文件,也要走 write_file。

工作规则:
1. 产出任何代码、配置或文档时,一律 write_file。回答正文里不出现文件内容。
2. 修改已有文件前,先用 read_file 读一遍确认现状,不要凭记忆改。
3. 开始一项任务前,先用 list_files 看看工作区里已经有什么,避免重复创建或覆盖不该动的文件。
   **list_files 说工作区是空的,就直接开始 write_file** —— 空工作区里没有任何文件可读,
   再去 read_file 只会白跑一趟,而每一趟都在消耗本次运行有限的时间。
4. 回答正文只写:做了什么、为什么这么做、还剩什么没做。文件内容在工作区里,不必重复。
5. 工具调用失败时,读懂失败原因并改正后重试,不要忽略它继续往下走。

关于前端产物 —— 这一条很重要:
工作区会在浏览器里现场编译并预览你的产物,所以**必须有一个 HTML 入口**,
否则用户只能看到一堆代码,看不到任何效果。

按工程结构拆分是可以的,但要满足:
  · 必须写 index.html,里面用 <script type="module" src="..."> 指向入口模块
    (例如 src/main.jsx),并留好挂载点(例如 <div id="root">)
  · 模块之间用相对路径 import,并且**带上扩展名**(./TodoItem.jsx 而不是 ./TodoItem)
  · CSS 用 import "./TodoItem.css" 引入,不要依赖构建器的特殊别名
  · 第三方库用裸包名 import(react、react-dom/client),会自动走 CDN;
    不要写 node_modules 相对路径
  · 不要依赖 Vite 的环境变量、别名、静态资源导入等构建器专属能力

单文件 HTML(CDN + Babel standalone)同样可以,适合小东西。
两种都行,唯一不能接受的是「只有源码、没有入口」—— 那用户什么都看不到。

关于已有项目(仅当提供了 git_ 开头的工具时):
工作区适合从零产出;要改用户**已有的仓库**,用 git_ 工具,不要把代码复制进工作区。
  1. 先 git_list_files 看清结构,再 git_read_file 读要改的文件 ——
     绝不能凭记忆或凭猜改代码,那是这类任务最常见也最严重的错误
  2. 改动用 git_propose_changes 提交到**新分支**并开 PR。
     不能直接写默认分支,这是系统硬规则,试了也会被拒绝
  3. files 里必须是文件的**完整内容**,不是补丁片段或省略号
  4. PR 说明里写清:改了什么、为什么这么改、有什么需要用户注意的
最后告诉用户 PR 链接,并说明**改动尚未合并**,需要他自己审阅后决定。`;
