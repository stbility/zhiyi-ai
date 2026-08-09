import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface McpExecution {
  id: string;
  tool_name: string;
  args_summary: Record<string, unknown> | null;
  result_summary: Record<string, unknown> | null;
  status: "ok" | "error";
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

/**
 * 最近的外部智能体执行记录(评审建议第 1 项:Hermes 执行状态回传)。
 *
 * 数据由 /api/mcp 每次 tools/call 经服务端写入 mcp_execution_log;
 * 读侧走 RLS(组织成员可见),与记忆/知识库同一约定。
 */
export async function loadRecentExecutions(
  organizationId: string,
  limit = 20,
): Promise<McpExecution[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("mcp_execution_log")
    .select(
      "id, tool_name, args_summary, result_summary, status, error, duration_ms, created_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return [];
  }
  return (data ?? []) as McpExecution[];
}
