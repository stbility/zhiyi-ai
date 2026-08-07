"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMyOrganizations } from "@/lib/db/queries";
import {
  installUrl,
  issueState,
  listRepositories,
  normalizeSlug,
  uninstallApp,
  verifyAppSlug,
} from "@/lib/integrations/github";

/**
 * 用手填的应用名直接去连接。
 *
 * 为什么需要这条路:安装地址只能是
 * https://github.com/apps/<slug>/installations/new(官方文档确认没有别的形式),
 * 而 slug 我们有两条获取路径 —— GET /app 需要认证,环境变量需要重新部署。
 * 两条都不通的时候,卡片上就一个可点的东西都没有了,用户面对一个死页面。
 *
 * 但**用户自己知道这个名字** —— 它就印在 GitHub App 的设置页上,
 * 也在应用主页的网址里。让他填一次,比让他去改环境变量再等一次部署快得多。
 *
 * 填进来的值不落库:它是平台级配置(整个平台共用一个 GitHub App),
 * 存到某个组织名下会造成「这是这个组织的设置」的错觉。这里只做一件事:
 * 查证它真实存在,然后把人送过去。长期的正解仍然是配好环境变量。
 */

export interface ConnectState {
  error?: string;
}

const schema = z.object({
  // 粘网址进来也认。用户手上最容易复制到的就是
  // https://github.com/settings/apps/<名字> —— 那是 App 设置页的地址,
  // 而页面上没有任何地方单独把「名字」标出来给人抄。
  // 直接判它不合法,是把设计的问题算到用户头上。
  slug: z
    .string()
    .max(300, "内容过长")
    .transform((v) => normalizeSlug(v))
    .refine(
      (v): v is string => v !== null,
      "认不出应用名称。填 GitHub App 的名字(例如 zhiyi-ai-repo),或直接粘它的网址。",
    ),
});

export async function connectViaSlug(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const parsed = schema.safeParse({ slug: formData.get("slug") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const orgs = await getMyOrganizations();
  const org = orgs.find((o) => o.role === "owner" || o.role === "admin");
  if (!org) {
    return { error: "需要组织管理员才能连接仓库。" };
  }

  // 先查证再跳转。不查证的话,填错一个字母就又是一个 GitHub 的 404 ——
  // 而那正是这几轮反复出现的那个问题。
  const 存在 = await verifyAppSlug(parsed.data.slug);
  if (!存在) {
    return {
      error:
        `GitHub 上没有名为「${parsed.data.slug}」的应用。` +
        `请到 GitHub App 的设置页核对 —— 它也出现在应用主页的网址里,` +
        `形如 github.com/apps/这里就是。`,
    };
  }

  redirect(installUrl(parsed.data.slug, issueState(org.id)));
}

export interface DisconnectState {
  error?: string;
  /** 本地断开了,但 GitHub 侧没收回 —— 这不是成功,也不是纯失败 */
  warning?: string;
  ok?: boolean;
}

/**
 * 断开 Git 连接。
 *
 * 官方做法对齐 ChatGPT / Codex 的 GitHub 连接器:已连接状态下同时提供
 * 「选择仓库」(跳 GitHub 的仓库授权页)和「断开」两个动作 ——
 *   · 改仓库范围:Settings → Apps → GitHub → Choose repositories
 *   · 断开:      Settings → Apps → GitHub → Disconnect
 * 来源:help.openai.com/en/articles/11145903-connecting-github-to-chatgpt
 *
 * 顺序很重要:**先让 GitHub 收回权限,再删本地记录。**
 * 反过来的话,一旦卸载失败,本地记录已经没了 —— 界面显示「未连接」,
 * 而我们的私钥其实还能换出安装令牌照样读代码,且用户再也没有入口
 * 去断开它。那是最坏的一种结果:权限还在,但看不见也管不着。
 *
 * 卸载失败时不删本地记录,原样返回原因,让用户能再点一次。
 */
export async function disconnectGit(
  _prev: DisconnectState,
  formData: FormData,
): Promise<DisconnectState> {
  const installationId = String(formData.get("installationId") ?? "").trim();
  if (!installationId) return { error: "缺少安装编号,无法断开。" };

  const orgs = await getMyOrganizations();
  const org = orgs.find((o) => o.role === "owner" || o.role === "admin");
  if (!org) return { error: "需要组织管理员才能断开仓库连接。" };

  const 卸载失败 = await uninstallApp(installationId);
  if (卸载失败) {
    return {
      error:
        `没有断开 —— GitHub 侧的授权还在,所以本地记录也没删(删了你就再也点不到这个按钮了)。` +
        `${卸载失败} ` +
        `也可以直接去 GitHub 的 Settings → Applications → Installed GitHub Apps 里卸载。`,
    };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "数据库不可用,请稍后再试。" };

  const { error } = await supabase
    .from("git_installations")
    .delete()
    .eq("organization_id", org.id)
    .eq("provider", "github");

  if (error) {
    // GitHub 侧已经收回了,这一半是真的完成了 —— 说清楚,
    // 否则用户会以为权限还在,跑去 GitHub 上再卸载一次。
    return {
      warning:
        `GitHub 侧的授权已经收回,智能体已经读不到你的代码了。` +
        `但本站的连接记录没删掉(${error.message}),页面上可能还显示「已连接」。` +
        `刷新后仍然显示的话,再点一次断开即可 —— 那时会走到 404 分支,直接删记录。`,
    };
  }

  revalidatePath("/settings/integrations");
  return { ok: true };
}

export interface GitTestState {
  error?: string;
  /** 真实拉回来的仓库全名。空数组 = 连上了但一个仓库都没授权 */
  repos?: string[];
  ok?: boolean;
}

/**
 * 真的调一次 GitHub,把这个安装能看到的仓库列出来。
 *
 * 【为什么需要这个按钮】
 * 用户问「智能体真的能工作吗」,而在此之前唯一的验证方式是**跑一轮智能体**——
 * 那要选模型、写提示词、等它决定去调工具,任何一环出问题都会被误读成
 * 「Git 不通」。一次失败根本分不清是模型不行、提示词不对,还是仓库读不到。
 *
 * 这个动作只做一件事:用当前安装换一次令牌,拉一次仓库列表。
 * 成功就把**真实的仓库名**摆出来 —— 那是伪造不了的证据,
 * 也正好回答「智能体能碰哪些仓库」这个问题(它用的是同一份白名单)。
 *
 * 走的是 listRepositories,与 loadGitContext 装配智能体上下文时**同一个函数**。
 * 所以这里通了,智能体那边就是通的;这里不通,那边也一定不通。
 * 另写一个"测试专用"的调用是没有意义的 —— 它证明不了真实链路。
 */
export async function testGitAccess(
  _prev: GitTestState,
  _formData: FormData,
): Promise<GitTestState> {
  void _prev; // useActionState(prev, formData) 签名占位,本 action 不需要 prev
  void _formData; // 同上;所有输入走 getMyOrganizations / git_installations
  const orgs = await getMyOrganizations();
  const org = orgs.find((o) => o.role === "owner" || o.role === "admin");
  if (!org) return { error: "需要组织管理员才能测试仓库连接。" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "数据库不可用,请稍后再试。" };

  const { data } = await supabase
    .from("git_installations")
    .select("installation_id")
    .eq("organization_id", org.id)
    .eq("provider", "github")
    .maybeSingle();

  const installationId = data?.installation_id as string | undefined;
  if (!installationId) {
    return { error: "这个组织还没有连接 GitHub。" };
  }

  const result = await listRepositories(installationId);
  if (!result.ok) {
    // 原话照抄。这一步失败的原因各不相同(私钥不对、安装已被卸载、
    // 限流),每种对应不同的修法 —— 盖成一句「测试失败」等于什么都没说。
    return { error: result.error };
  }

  return { ok: true, repos: result.repos.map((r) => r.fullName) };
}
