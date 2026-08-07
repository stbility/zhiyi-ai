"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { parseSkillMarkdown, SkillParseError } from "@/lib/ai/skills";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/log";

/**
 * 技能库的维护:导入 SKILL.md / 启停 / 删除。
 *
 * 写操作走**用户身份客户端**,「谁能改」由迁移 0031 的 RLS 策略
 * (限 owner/admin)决定。
 *
 * 导入的核心是 frontmatter 解析:对齐 Hermes 的 SKILL.md 规范 ——
 * 同一份技能文件(Hermes 本地 / zhiyi-ai 产品)两端都能跑。
 * 解析失败时给出能照着改的错误,而不是把半成品塞进库。
 */

export interface SkillState {
  readonly error?: string;
  readonly ok?: string;
}

const importSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
  /** 完整 SKILL.md 内容:frontmatter + 正文 */
  markdown: z.string().trim().min(10, "技能内容太短,不像是完整的 SKILL.md"),
});

export async function importSkill(
  _prev: SkillState,
  formData: FormData,
): Promise<SkillState> {
  const parsed = importSchema.safeParse({
    organizationId: formData.get("organizationId"),
    markdown: formData.get("markdown"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  // frontmatter 解析失败要给出能照着改的说明 —— 用户大概率是
  // 从别处复制了一份格式略有出入的技能文件
  let skill: ReturnType<typeof parseSkillMarkdown>;
  try {
    skill = parseSkillMarkdown(parsed.data.markdown);
  } catch (e) {
    if (e instanceof SkillParseError) {
      return { error: `技能文件解析失败:${e.message}` };
    }
    return { error: "技能文件解析失败:未知错误" };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const { error } = await supabase.from("skills").insert({
    organization_id: parsed.data.organizationId,
    name: skill.name,
    title: skill.title,
    description: skill.description,
    version: skill.version,
    author: skill.author || null,
    license: skill.license,
    platforms: skill.platforms,
    tags: skill.tags,
    related_skills: skill.relatedSkills,
    body: skill.body,
    created_by: user.id,
  });

  if (error) {
    if (error.code === "42501") {
      return {
        error: "没有权限导入技能。只有组织的所有者或管理员可以操作。",
      };
    }
    if (error.code === "23505") {
      return { error: `技能 ${skill.name} 已存在。先删除旧的再导入,或改用别的名字。` };
    }
    logger.error({ dbError: error.message }, "导入技能失败");
    return { error: error.message };
  }

  revalidatePath("/settings/skills");
  return { ok: `已导入 ${skill.name} v${skill.version}(${skill.title})。` };
}

const idSchema = z.object({
  id: z.string().uuid("标识无效"),
  organizationId: z.string().uuid("组织标识无效"),
});

/** 启停。关掉的技能不再出现在 skill_list 里,但内容保留。 */
export async function toggleSkill(
  _prev: SkillState,
  formData: FormData,
): Promise<SkillState> {
  const parsed = idSchema.safeParse({
    id: formData.get("id"),
    organizationId: formData.get("organizationId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { data: row } = await supabase
    .from("skills")
    .select("name, enabled")
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId)
    .maybeSingle();
  if (!row) return { error: "找不到这个技能,或你没有权限访问它。" };

  const { error, count } = await supabase
    .from("skills")
    .update(
      { enabled: !row.enabled, updated_at: new Date().toISOString() },
      { count: "exact" },
    )
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId);

  if (error) {
    if (error.code === "42501") {
      return { error: "没有权限修改。只有组织的所有者或管理员可以操作。" };
    }
    return { error: error.message };
  }
  if ((count ?? 0) === 0) return { error: "没有权限修改,或它已被删除。" };

  revalidatePath("/settings/skills");
  return {
    ok: row.enabled
      ? `已停用 ${row.name}。它不再出现在智能体的技能列表里,内容保留。`
      : `已启用 ${row.name}。智能体将能通过 skill_list 看到它。`,
  };
}

/** 删除。连正文带附件一起移除。 */
export async function deleteSkill(
  _prev: SkillState,
  formData: FormData,
): Promise<SkillState> {
  const parsed = idSchema.safeParse({
    id: formData.get("id"),
    organizationId: formData.get("organizationId"),
  });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  // skill_files 跟着 skills 走 on delete cascade —— 只删技能即可
  const { error, count } = await supabase
    .from("skills")
    .delete({ count: "exact" })
    .eq("id", parsed.data.id)
    .eq("organization_id", parsed.data.organizationId);

  if (error) {
    if (error.code === "42501") {
      return { error: "没有权限删除。只有组织的所有者或管理员可以操作。" };
    }
    return { error: error.message };
  }
  if ((count ?? 0) === 0) return { error: "没有权限删除,或它已被删除。" };

  revalidatePath("/settings/skills");
  return { ok: "已删除。智能体将不再看到这个技能。" };
}
