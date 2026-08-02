"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 工作区文件的删除。
 *
 * 智能体会写错文件、写重复文件,用户必须能清理 —— 否则工作区很快就变成
 * 一堆无法分辨的残留。走用户身份客户端,RLS 保证只能删自己组织的。
 */

export interface WorkspaceActionState {
  readonly error?: string;
}

const schema = z.object({
  workspaceId: z.string().uuid(),
  path: z.string().trim().min(1).max(400),
});

export async function deleteWorkspaceFile(
  _prev: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const parsed = schema.safeParse({
    workspaceId: formData.get("workspaceId"),
    path: formData.get("path"),
  });
  if (!parsed.success) return { error: "参数无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("workspace_files")
    .delete({ count: "exact" })
    .eq("workspace_id", parsed.data.workspaceId)
    .eq("path", parsed.data.path);
  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  revalidatePath("/workspace");
  return {};
}

const workspaceSchema = z.object({ workspaceId: z.string().uuid() });

/** 删除整个工作区 —— 试错留下的空工作区不该一直堆着 */
export async function deleteWorkspace(
  _prev: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const parsed = workspaceSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
  });
  if (!parsed.success) return { error: "参数无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("workspaces")
    .delete({ count: "exact" })
    .eq("id", parsed.data.workspaceId);
  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  revalidatePath("/workspace");
  return {};
}
