"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMyOrganizations } from "@/lib/db/queries";
import {
  detectFileType,
  extractText,
  KNOWLEDGE_UPLOAD_MAX_BYTES,
  type KnowledgeFileType,
} from "@/lib/knowledge/parse";

export interface KnowledgeActionResult {
  readonly ok?: string;
  readonly error?: string;
}

const idSchema = z.string().uuid("标识无效");

async function requireKnowledgeContext() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" } as const;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "请先登录。" } as const;
  const organizations = await getMyOrganizations();
  const organization = organizations?.[0];
  if (!organization) return { error: "没有可用的组织。" } as const;
  return { supabase, user, organization } as const;
}

export async function uploadKnowledgeFile(
  _prev: unknown,
  formData: FormData,
): Promise<KnowledgeActionResult> {
  const ctx = await requireKnowledgeContext();
  if ("error" in ctx) return { error: ctx.error };

  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "没有收到文件。" };
  const name = file.name.trim();
  if (name.length === 0 || name.length > 255) return { error: "文件名需为 1-255 字。" };
  if (file.size === 0) return { error: "文件是空的。" };
  if (file.size > KNOWLEDGE_UPLOAD_MAX_BYTES) {
    return { error: "文件超过 10MB 上限。" };
  }
  const fileType = detectFileType(name);
  if (fileType === "other") {
    return { error: "暂支持 pdf / docx / md / txt,请上传这些格式。" };
  }

  // 入库:先以 parsing 状态落行,解析完成后原地更新 ——
  // 状态机 5 态与设计系统 KnowledgeFileRow 对齐。
  const { data: created, error: insertError } = await ctx.supabase
    .from("knowledge_files")
    .insert({
      organization_id: ctx.organization.id,
      name,
      file_type: fileType as KnowledgeFileType,
      size_bytes: file.size,
      status: "parsing",
      created_by: ctx.user.id,
    })
    .select("id")
    .single();
  if (insertError || !created) {
    return { error: `入库失败:${insertError?.message ?? "未知错误"}` };
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const parsed = await extractText(buffer, fileType);

  if (!parsed.ok) {
    await ctx.supabase
      .from("knowledge_files")
      .update({
        status: "failed",
        error: parsed.error,
        updated_at: new Date().toISOString(),
      })
      .eq("id", created.id);
    revalidatePath("/knowledge");
    return { ok: `「${name}」解析失败:${parsed.error}` };
  }

  await ctx.supabase
    .from("knowledge_files")
    .update({
      status: "ready",
      content_text: parsed.text,
      updated_at: new Date().toISOString(),
    })
    .eq("id", created.id);

  revalidatePath("/knowledge");
  return { ok: `「${name}」已入库,可用于智能体检索。` };
}

export async function deleteKnowledgeFile(id: string): Promise<KnowledgeActionResult> {
  const ctx = await requireKnowledgeContext();
  if ("error" in ctx) return { error: ctx.error };
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { error: idParsed.error.issues[0]?.message ?? "标识无效" };

  const { error, count } = await ctx.supabase
    .from("knowledge_files")
    .delete({ count: "exact" })
    .eq("id", idParsed.data);
  if (error) return { error: error.message };
  if ((count ?? 0) === 0) return { error: "只能删除自己上传的文件,或文件已不存在。" };

  revalidatePath("/knowledge");
  return { ok: "已删除。" };
}
