import "server-only";

import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { GIT_TOOLS, executeGitTool, loadGitContext } from "@/lib/ai/git-tools";
import { logger } from "@/lib/log";

/**
 * 通过 MCP 对外暴露的工具。
 *
 * 这里只放**真实存在**的能力。品牌人格、技能库、长期记忆、评测集那几张表
 * 还没建(P5),所以它们的工具一个都不出现在这里 —— 暴露一个返回空数据的
 * `get_persona` 比不暴露更糟:接入方会据此以为功能已通,而它其实是空的。
 * 这和界面上「未接通不得标记为已就绪」是同一条规则。
 *
 * ⚠️ 安全模型与浏览器那条路**完全不同**。
 *
 * 浏览器侧:用户会话 + RLS 双保险,应用层写错了范围,数据库还会挡住。
 * 这条路上:令牌解析出的 organizationId 是**唯一防线**,而且下面全部走
 * service_role(它绕过 RLS)。所以每一个查询都必须显式带上
 * `.eq("organization_id", organizationId)` —— 漏一处就是跨组织泄露,
 * 没有第二道网。
 *
 * 为什么不走用户身份客户端让 RLS 兜底:这条路上根本没有用户会话,
 * 令牌不是 Supabase 的 JWT。真要有兜底,得给每个组织签一个 Postgres 角色,
 * 那是另一个量级的工程。现在的做法是:收窄写在每一处,并用跨组织隔离测试
 * 把它钉死(见 tests/mcp/isolation.test.ts)。
 */

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema。MCP 规范里叫 inputSchema,不是 OpenAI 的 parameters */
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
}

const pathSchema = z
  .string()
  .trim()
  .min(1, "路径不能为空")
  .max(400, "路径过长")
  .refine((p) => !p.startsWith("/"), "路径必须是相对路径")
  .refine((p) => !p.split("/").includes(".."), "路径不能包含 ..")
  // 控制字符用转义写法,不要把字节字面打进源码 —— tools.ts 那边踩过:
  // 字面控制字符会让 git 把整个文件判成二进制,diff 不可见,
  // 而这正是最需要逐行审查的一类文件(它决定路径能不能穿越出工作区)
  .refine((p) => !/[\u0000-\u001f]/.test(p), "路径含非法字符");

const workspaceIdSchema = z.string().uuid("工作区标识无效");

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "zhiyi_whoami",
    description:
      "确认当前令牌代表哪个组织。接入时先调它验证连通性 —— 拿不到组织信息就说明令牌无效,不必再往下试。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "zhiyi_workspace_list",
    description:
      "列出该组织的全部工作区及其中的文件路径与大小。开始干活前先看清有什么,不要凭猜去读文件。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "只看某一个工作区,留空则列出全部",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "zhiyi_workspace_read",
    description:
      "读取工作区里的一个文件。修改任何文件之前都应当先读一遍确认现状,不要凭记忆改。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作区标识" },
        path: { type: "string", description: "工作区内的相对路径" },
      },
      required: ["workspaceId", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "zhiyi_workspace_write",
    description:
      "把文件写入工作区。产出代码、配置、文档时用这个,不要把文件内容贴在回答正文里。同一路径重复写入即覆盖。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作区标识" },
        path: { type: "string", description: "工作区内的相对路径" },
        content: { type: "string", description: "文件完整内容" },
      },
      required: ["workspaceId", "path", "content"],
      additionalProperties: false,
    },
  },
];

/**
 * Git 工具的 MCP 外壳。
 *
 * 定义**不在这里重写** —— 直接从 GIT_TOOLS 转译。两处各写一份 JSON Schema
 * 的话,参数说明、必填项、边界值迟早对不上,而这些工具决定的是
 * 「哪些仓库能碰」「能不能直接写 main」,对不上就是安全问题。
 *
 * 只做两件事:
 *   · 名字加 zhiyi_ 前缀 —— MCP 客户端会同时接好几个服务器,
 *     一个叫 git_read_file 的工具跟别家撞名是迟早的事
 *   · parameters → inputSchema —— MCP 规范的字段名与 OpenAI 的不同
 */
const GIT_TOOL_PREFIX = "zhiyi_";

export const MCP_GIT_TOOLS: readonly McpToolDefinition[] = GIT_TOOLS.map(
  (t) => ({
    name: `${GIT_TOOL_PREFIX}${t.function.name}`,
    description: t.function.description,
    inputSchema: t.function.parameters,
  }),
);

/** MCP 侧的名字还原成内部工具名 */
function internalGitName(name: string): string | null {
  if (!name.startsWith(GIT_TOOL_PREFIX)) return null;
  const inner = name.slice(GIT_TOOL_PREFIX.length);
  return GIT_TOOLS.some((t) => t.function.name === inner) ? inner : null;
}

/**
 * 这个组织当前能用的工具清单。
 *
 * Git 工具**只在真的连了仓库时才出现**,与站内智能体的行为一致
 * (agent.ts 里也是 gitContext 有值才把 GIT_TOOLS 挂上去)。
 *
 * 为什么不无条件列出来:MCP 客户端拿到工具清单就会去用。列一个必然失败的
 * git_read_file,对面会先花几轮去试、再自己猜原因 —— 而真正的原因
 * (这个组织还没连 GitHub)它无从得知。不如不列。
 *
 * 这里只查一次数据库(有没有安装记录),不去 GitHub 拉仓库列表 ——
 * tools/list 会被频繁调用,而完整白名单只有真正执行时才需要。
 */
export async function listMcpTools(
  organizationId: string,
): Promise<readonly McpToolDefinition[]> {
  const admin = createSupabaseAdminClient();
  if (!admin) return MCP_TOOLS;

  const { data } = await admin
    .from("git_installations")
    .select("installation_id")
    // service_role 绕过 RLS,这一句是唯一防线
    .eq("organization_id", organizationId)
    .eq("provider", "github")
    .maybeSingle();

  return data?.installation_id
    ? [...MCP_TOOLS, ...MCP_GIT_TOOLS]
    : MCP_TOOLS;
}

/** 单个文件回传给模型的上限 —— 与智能体侧同一个理由:上下文是有限的 */
const MAX_READ_CHARS = 30_000;

/**
 * 执行一次工具调用。
 *
 * 永不抛错:失败是调用方需要知道的观察结果,不是传输层故障。
 * 抛出去只会变成一个 JSON-RPC 内部错误,对面看不出哪里不对。
 */
export async function executeMcpTool(
  name: string,
  args: unknown,
  organizationId: string,
): Promise<McpToolResult> {
  const fail = (text: string): McpToolResult => ({ text, isError: true });

  const admin = createSupabaseAdminClient();
  if (!admin) return fail("服务端未配置数据库访问,暂时无法处理。");

  // Git 工具:装配上下文后交给**站内智能体用的同一个执行器**。
  //
  // 不在这里另写一遍。白名单校验、「不许直接写默认分支」、
  // 「提交成功但开 PR 失败要说清楚改动已经在分支上」这些规则,
  // 两份实现迟早分叉 —— 而分叉的后果是模型在某一条路上绕过了
  // 另一条路上的硬规则。
  const gitName = internalGitName(name);
  if (gitName) {
    const ctx = await loadGitContext(admin, organizationId);
    if (!ctx) {
      return fail(
        "这个组织还没有连接 GitHub 仓库,或授权范围里没有任何仓库。" +
          "请到智一 AI 的「设置 → 集成」页连接后再试。",
      );
    }
    const outcome = await executeGitTool(
      {
        id: `mcp-${Date.now()}`,
        name: gitName,
        rawArguments: JSON.stringify(args ?? {}),
      },
      ctx,
    );
    return { text: outcome.content, isError: !outcome.ok };
  }

  try {
    switch (name) {
      case "zhiyi_whoami": {
        const { data } = await admin
          .from("organizations")
          .select("id, name, slug")
          .eq("id", organizationId)
          .maybeSingle();
        if (!data) return fail("令牌对应的组织已不存在。");
        return {
          isError: false,
          text: `组织:${data.name as string}(${data.slug as string})\n组织标识:${data.id as string}`,
        };
      }

      case "zhiyi_workspace_list": {
        const parsed = z
          .object({ workspaceId: workspaceIdSchema.optional() })
          .safeParse(args ?? {});
        if (!parsed.success) {
          return fail(`参数不合法:${parsed.error.issues[0]?.message}`);
        }

        let query = admin
          .from("workspaces")
          .select("id, name, created_at")
          // 唯一防线:service_role 绕过 RLS,漏了这一句就是跨组织泄露
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: false });
        if (parsed.data.workspaceId) {
          query = query.eq("id", parsed.data.workspaceId);
        }
        const { data: spaces } = await query;
        if (!spaces || spaces.length === 0) {
          return { isError: false, text: "这个组织还没有工作区。" };
        }

        const { data: files } = await admin
          .from("workspace_files")
          .select("workspace_id, path, size_chars")
          .eq("organization_id", organizationId)
          .order("path");

        const lines: string[] = [];
        for (const w of spaces) {
          const wid = w.id as string;
          lines.push(`# ${w.name as string}(${wid})`);
          const own = (files ?? []).filter((f) => f.workspace_id === wid);
          if (own.length === 0) lines.push("  (空)");
          for (const f of own) {
            lines.push(`  ${f.path as string}(${(f.size_chars as number) ?? 0} 字符)`);
          }
        }
        return { isError: false, text: lines.join("\n") };
      }

      case "zhiyi_workspace_read": {
        const parsed = z
          .object({ workspaceId: workspaceIdSchema, path: pathSchema })
          .safeParse(args);
        if (!parsed.success) {
          return fail(`参数不合法:${parsed.error.issues[0]?.message}`);
        }

        const { data } = await admin
          .from("workspace_files")
          .select("content")
          .eq("organization_id", organizationId)
          .eq("workspace_id", parsed.data.workspaceId)
          .eq("path", parsed.data.path)
          .maybeSingle();

        if (!data) {
          // 「文件不存在」是正常观察,不是错误 —— 调用方据此决定新建
          return {
            isError: false,
            text: `工作区里没有 ${parsed.data.path}。`,
          };
        }

        const content = data.content as string;
        if (content.length > MAX_READ_CHARS) {
          return {
            isError: false,
            text:
              content.slice(0, MAX_READ_CHARS) +
              `\n\n…[内容过长,此处截断。原文共 ${content.length} 个字符,` +
              `已显示前 ${MAX_READ_CHARS} 个。]`,
          };
        }
        return { isError: false, text: content };
      }

      case "zhiyi_workspace_write": {
        const parsed = z
          .object({
            workspaceId: workspaceIdSchema,
            path: pathSchema,
            content: z.string().max(400_000, "单个文件过大"),
          })
          .safeParse(args);
        if (!parsed.success) {
          return fail(`参数不合法:${parsed.error.issues[0]?.message}`);
        }

        // 先确认工作区确实属于这个组织。
        // 少了这一步,拿着 A 组织的令牌写 B 组织的 workspaceId 就会成功 ——
        // 因为下面的 upsert 是按 (workspace_id, path) 冲突,
        // organization_id 只是跟着写进去的一个字段,不构成约束。
        const { data: owned } = await admin
          .from("workspaces")
          .select("id")
          .eq("organization_id", organizationId)
          .eq("id", parsed.data.workspaceId)
          .maybeSingle();
        if (!owned) {
          return fail("找不到这个工作区,或它不属于当前令牌所在的组织。");
        }

        const { error } = await admin.from("workspace_files").upsert(
          {
            workspace_id: parsed.data.workspaceId,
            organization_id: organizationId,
            path: parsed.data.path,
            content: parsed.data.content,
            size_chars: parsed.data.content.length,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,path" },
        );
        if (error) {
          logger.error(
            { organizationId, dbError: error.message },
            "MCP 写入工作区失败",
          );
          return fail(`写入失败:${error.message}`);
        }

        return {
          isError: false,
          text: `已写入 ${parsed.data.path}(${parsed.data.content.length} 字符)。`,
        };
      }

      default:
        return fail(`未知的工具:${name}`);
    }
  } catch (e) {
    logger.error(
      { organizationId, tool: name, err: e instanceof Error ? e.message : "?" },
      "MCP 工具执行异常",
    );
    return fail(`执行失败:${e instanceof Error ? e.message : "未知错误"}`);
  }
}
