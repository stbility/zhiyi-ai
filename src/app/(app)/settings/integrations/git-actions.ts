"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getMyOrganizations } from "@/lib/db/queries";
import {
  installUrl,
  issueState,
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
  // GitHub 的 App 名称转成 slug 后只含小写字母、数字、连字符
  slug: z
    .string()
    .trim()
    .min(1, "请填写应用名称")
    .max(100, "应用名称过长")
    .regex(/^[a-zA-Z0-9-]+$/, "应用名称只含字母、数字与连字符"),
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
