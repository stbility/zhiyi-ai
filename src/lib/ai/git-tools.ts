import "server-only";

import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ToolDefinition, ToolCall, ToolResult } from "@/lib/ai/tools";
import { logger } from "@/lib/log";
import {
  commitFiles,
  listRepoFiles,
  listRepositories,
  openPullRequest,
  parseRepo,
  readRepoFile,
} from "@/lib/integrations/github";

/**
 * 智能体的 Git 仓库工具。
 *
 * 与工作区文件工具的分工:
 *   工作区 —— 从零产出的东西(新写的组件、报告、脚本),不涉及已有代码
 *   Git    —— 改用户**已有的项目**。读真实代码、在分支上提交、开 PR
 *
 * 最重要的一条硬规则:**绝不直接写默认分支**。
 *
 * 这不是可配置项。模型会犯错,而且它犯的错往往看起来很合理 ——
 * 让它直接推 main 意味着一次误判就能覆盖用户的代码,中间没有任何拦截点。
 * 走分支 + PR 之后,用户在合并前一定会看到 diff。
 * 那道人工确认是整条链路里唯一不能省的一环,也是「智能体能改代码」
 * 这件事在商业交付里能被接受的前提。
 */

const repoSchema = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, "仓库格式应为 owner/repo");

const pathSchema = z
  .string()
  .trim()
  .min(1, "路径不能为空")
  .max(400, "路径过长")
  .refine((p) => !p.startsWith("/"), "路径必须是相对路径")
  .refine((p) => !p.split("/").includes(".."), "路径不能包含 ..");

/** 分支名。禁掉会被 Git 拒绝或产生歧义的字符,免得提交到一半才失败 */
const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w./-]+$/, "分支名含非法字符")
  .refine((b) => !b.startsWith("-") && !b.includes(".."), "分支名不合法");

export const gitListSchema = z.object({
  repo: repoSchema,
  path: z.string().trim().max(400).optional(),
  ref: z.string().trim().max(200).optional(),
});

export const gitReadSchema = z.object({
  repo: repoSchema,
  path: pathSchema,
  ref: z.string().trim().max(200).optional(),
});

export const gitProposeSchema = z.object({
  repo: repoSchema,
  branch: branchSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(20_000).default(""),
  files: z
    .array(
      z.object({
        path: pathSchema,
        content: z.string().max(400_000, "单个文件过大"),
      }),
    )
    .min(1, "至少要有一个文件")
    .max(50, "一次最多提交 50 个文件"),
});

export const GIT_TOOLS: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "git_list_files",
      description:
        "列出已连接仓库某个目录下的文件与子目录。动手改代码之前先用它看清项目结构,不要凭猜去读文件。",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "仓库全名,形如 owner/repo" },
          path: { type: "string", description: "目录路径,留空表示仓库根目录" },
          ref: { type: "string", description: "分支或提交,留空用默认分支" },
        },
        required: ["repo"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_read_file",
      description:
        "读取已连接仓库里的一个文件。修改任何文件之前必须先读一遍确认现状,绝不能凭记忆改。",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "仓库全名,形如 owner/repo" },
          path: { type: "string", description: "仓库内文件路径" },
          ref: { type: "string", description: "分支或提交,留空用默认分支" },
        },
        required: ["repo", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_propose_changes",
      description:
        "把一批改动提交到新分支并开一个 Pull Request,交给用户审阅。" +
        "这是修改已有项目的唯一方式 —— 不能直接写默认分支。" +
        "提交的必须是文件的完整内容,不是补丁片段。",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "仓库全名,形如 owner/repo" },
          branch: {
            type: "string",
            description: "新分支名,建议形如 zhiyi/修复登录重定向",
          },
          title: { type: "string", description: "PR 标题" },
          body: { type: "string", description: "PR 说明:改了什么、为什么" },
          files: {
            type: "array",
            description: "要写入的文件,内容必须完整",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["repo", "branch", "title", "files"],
        additionalProperties: false,
      },
    },
  },
];

/** Git 工具执行需要的上下文 —— 由调用方注入,工具本身不认识数据库 */
export interface GitToolContext {
  readonly installationId: string;
  /** 用户授权的仓库白名单。不在名单里的一律拒绝 */
  readonly allowedRepos: readonly string[];
  /** 各仓库的默认分支,用于判定「不许直接写」以及作为 PR 的基线 */
  readonly defaultBranches: Readonly<Record<string, string>>;
}

function fail(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, content, ok: false };
}

function done(call: ToolCall, content: string): ToolResult {
  return { callId: call.id, name: call.name, content, ok: true };
}

/**
 * 执行一次 Git 工具调用。
 *
 * 和文件工具一样:**永不抛错**。工具失败是模型需要知道的观察结果,
 * 不是系统故障 —— 把原因如实回喂,模型才能改正。
 */
export async function executeGitTool(
  call: ToolCall,
  ctx: GitToolContext,
): Promise<ToolResult> {
  let args: unknown;
  try {
    args = JSON.parse(call.rawArguments === "" ? "{}" : call.rawArguments);
  } catch {
    return fail(call, "参数不是合法的 JSON,请重新生成这次调用。");
  }

  /** 仓库白名单校验。用户在 GitHub 上勾了哪些,我们就只能碰哪些 */
  const checkRepo = (repo: string): string | null => {
    if (!ctx.allowedRepos.includes(repo)) {
      return (
        `仓库 ${repo} 不在授权范围内。当前可访问:` +
        (ctx.allowedRepos.length > 0
          ? ctx.allowedRepos.join("、")
          : "(没有任何仓库,请先到「集成」页连接 GitHub)")
      );
    }
    return null;
  };

  switch (call.name) {
    case "git_list_files": {
      const parsed = gitListSchema.safeParse(args);
      if (!parsed.success) {
        return fail(call, `参数不合法:${parsed.error.issues[0]?.message}`);
      }
      const denied = checkRepo(parsed.data.repo);
      if (denied) return fail(call, denied);

      const ref = parseRepo(parsed.data.repo)!;
      const r = await listRepoFiles(
        ctx.installationId,
        { ...ref, ...(parsed.data.ref ? { ref: parsed.data.ref } : {}) },
        parsed.data.path ?? "",
      );
      if (!r.ok) return fail(call, r.error);
      if (r.entries.length === 0) return done(call, "这个目录是空的。");

      return done(
        call,
        r.entries
          .map((e) => `${e.type === "dir" ? "[目录] " : ""}${e.path}`)
          .join("\n"),
      );
    }

    case "git_read_file": {
      const parsed = gitReadSchema.safeParse(args);
      if (!parsed.success) {
        return fail(call, `参数不合法:${parsed.error.issues[0]?.message}`);
      }
      const denied = checkRepo(parsed.data.repo);
      if (denied) return fail(call, denied);

      const ref = parseRepo(parsed.data.repo)!;
      const r = await readRepoFile(
        ctx.installationId,
        { ...ref, ...(parsed.data.ref ? { ref: parsed.data.ref } : {}) },
        parsed.data.path,
      );
      if (!r.ok) return fail(call, r.error);

      return done(call, `${parsed.data.path} 的内容:\n\n${r.file.content}`);
    }

    case "git_propose_changes": {
      const parsed = gitProposeSchema.safeParse(args);
      if (!parsed.success) {
        return fail(call, `参数不合法:${parsed.error.issues[0]?.message}`);
      }
      const denied = checkRepo(parsed.data.repo);
      if (denied) return fail(call, denied);

      const base = ctx.defaultBranches[parsed.data.repo] ?? "main";

      // 硬规则:不许直接写默认分支。
      // 放在这里而不是只写进提示词 —— 提示词是建议,代码才是保证。
      if (parsed.data.branch === base) {
        return fail(
          call,
          `不能直接提交到默认分支 ${base}。请换一个新分支名,改动会以 Pull Request 的形式交给用户审阅后再合并。`,
        );
      }

      const ref = parseRepo(parsed.data.repo)!;
      const committed = await commitFiles(ctx.installationId, ref, {
        branch: parsed.data.branch,
        baseBranch: base,
        message: parsed.data.title,
        files: parsed.data.files,
      });
      if (!committed.ok) return fail(call, committed.error);

      const pr = await openPullRequest(ctx.installationId, ref, {
        head: parsed.data.branch,
        base,
        title: parsed.data.title,
        body: parsed.data.body,
      });

      if (!pr.ok) {
        // 提交成功但开 PR 失败 —— 必须说清楚改动已经在分支上了,
        // 否则用户会以为整件事没发生,而分支其实已经躺在那里
        return fail(
          call,
          `改动已提交到分支 ${parsed.data.branch}(提交 ${committed.commitSha.slice(0, 7)}),但创建 PR 失败:${pr.error}`,
        );
      }

      return done(
        call,
        `已在分支 ${parsed.data.branch} 提交 ${parsed.data.files.length} 个文件,并创建 PR #${pr.pr.number}:${pr.pr.url}\n` +
          `改动尚未合并 —— 请审阅后自行决定是否合并。`,
      );
    }

    default:
      return fail(call, `未知的 Git 工具:${call.name}`);
  }
}

/**
 * 装配 Git 工具上下文。
 *
 * **授权仓库列表实时从 GitHub 拉,不缓存在我们库里。**
 *
 * 这一点很要紧:用户随时可能在 GitHub 侧把某个仓库移出授权范围,
 * 甚至整个卸载应用。把列表缓存下来意味着我们会拿着一份过期的白名单
 * 继续放行 —— 虽然 GitHub 那边最终会拒绝,但我们在自己这一层就该
 * 反映真实的授权状态,而不是让用户看到一个已经无权访问的仓库还在列表里。
 *
 * 代价是每次智能体运行多一次 GitHub 往返。相对于「权限判断基于过期数据」
 * 这个风险,这点开销完全值得。
 *
 * 放在这里而不是 agent-turn 里:MCP 那条路(外部智能体接进来)需要
 * **同一份**上下文。两处各写一遍的话,白名单和默认分支的取法迟早分叉 ——
 * 而它们决定的是「哪些仓库能碰」和「能不能直接写 main」,分叉的后果是安全问题。
 */
export async function loadGitContext(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<GitToolContext | undefined> {
  const { data } = await supabase
    .from("git_installations")
    .select("installation_id")
    .eq("organization_id", organizationId)
    .eq("provider", "github")
    .maybeSingle();

  const installationId = data?.installation_id as string | undefined;
  if (!installationId) return undefined;

  const repos = await listRepositories(installationId);
  if (!repos.ok) {
    logger.warn(
      { organizationId, reason: repos.error },
      "读取授权仓库列表失败,本轮不提供 Git 工具",
    );
    return undefined;
  }
  if (repos.repos.length === 0) return undefined;

  return {
    installationId,
    allowedRepos: repos.repos.map((r) => r.fullName),
    defaultBranches: Object.fromEntries(
      repos.repos.map((r) => [r.fullName, r.defaultBranch]),
    ),
  };
}
