import "server-only";

import type { WorkspaceFile } from "@/components/app/WorkspaceBrowser";
import type {
  ConversationSummary,
  InitialTurn,
  ModelOption,
} from "@/components/app/ChatPanel";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadPlatformCandidates } from "@/lib/ai/platform-models";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * AI 助手页与智能体页共用的读取逻辑。
 *
 * 两个页面是两条通道,但「有哪些模型可选」「这条对话说过什么」
 * 是同一件事。抽出来免得两份查询慢慢长歪。
 *
 * 过滤条件只有两个,而且都是**用户自己的决定**:模型启用、服务商启用。
 * 我们不加任何「我们认为它不可用」的过滤。
 */

export async function loadModels(
  organizationId: string,
): Promise<ModelOption[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("ai_models")
    .select("model_id, provider_id, ai_providers (display_name, enabled)")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    // **不按任何「我们判断它不可用」的标记过滤。**
    //
    // 这里曾经加了 .is("chat_unavailable_reason", null) —— 一个模型探测
    // 失败就从用户的选择列表里消失。而探测失败的原因常常是排队、限流、
    // 探测超时,模型本身好好的。用户的原话:「任何模型、服务商都不允许限制」。
    //
    // 只认用户自己的开关(enabled)和服务商的开关。他关了就不显示,
    // 我们不替他关。
    .order("model_id");

  const own: ModelOption[] = (data ?? []).flatMap((row) => {
    const provider = row.ai_providers as unknown as {
      display_name: string;
      enabled: boolean;
    } | null;
    if (!provider || provider.enabled === false) return [];

    const providerId = row.provider_id as string;
    const modelId = row.model_id as string;
    return [
      {
        providerId,
        providerName: provider.display_name,
        modelId,
        value: `${providerId}::${modelId}`,
      },
    ];
  });

  // 平台免费档也要出现在选择器里 —— 否则新用户看到的仍是一个空列表,
  // 「注册完直接能对话」照样不成立。
  //
  // 排在用户自己的模型之后:BYOK 是他自己配的,意图优先。
  // 但对新注册用户来说 own 是空的,平台档就是全部。
  //
  // free_only 的判定与候选链**共用同一个函数**(loadPlatformCandidates),
  // 不在这里另写一遍过滤 —— 两处各写一份的话,迟早出现
  // 「选择器里看得到、真调用时被拒」或者反过来「选不到但降级会用到」。
  const platform = await loadPlatformFor(supabase, organizationId);

  return [...own, ...platform];
}

/**
 * 平台档在选择器里的呈现。
 *
 * 只暴露 providerId / modelId / 显示名 —— 密钥(哪怕是密文)绝不进入
 * 这个返回值:它会被序列化下发到浏览器。
 * loadPlatformCandidates 返回的对象里带着 apiKeyCipher,
 * 所以这里必须**逐字段挑出来**,不能整个对象展开。
 */
async function loadPlatformFor(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ModelOption[]> {
  const { data } = await supabase
    .from("organizations")
    .select("free_only")
    .eq("id", organizationId)
    .maybeSingle();

  // 读不到时按免费档处理 —— 出错时的默认值要选代价小的那个
  const list = await loadPlatformCandidates(supabase, data?.free_only !== false);

  return list.map((c) => ({
    providerId: c.providerId,
    providerName: c.providerName,
    modelId: c.modelId,
    value: `${c.providerId}::${c.modelId}`,
  }));
}

/**
 * 某条通道的历史会话。
 *
 * 对话和消息一直都在库里,只是页面从不读取 —— 关掉标签页就等于全丢。
 * 这对「长期使用」是致命的:用户没法接着昨天的思路继续,也无法回看
 * 模型当时到底说了什么。
 *
 * 按 channel 过滤:AI 助手页不该列出智能体跑过的任务,反过来也一样。
 * 见迁移 0023。
 */
export async function loadConversations(
  organizationId: string,
  channel: "chat" | "agent",
): Promise<ConversationSummary[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  // RLS 已限定只能读到自己的对话,这里不必再按 user_id 过滤
  const { data } = await supabase
    .from("conversations")
    .select("id, title, created_at")
    .eq("organization_id", organizationId)
    .eq("channel", channel)
    .order("created_at", { ascending: false })
    .limit(50);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    title: (row.title as string | null) ?? "未命名对话",
    createdAt: row.created_at as string,
  }));
}

/** 某个对话的全部消息,用于恢复现场 */
export async function loadTurns(
  conversationId: string,
): Promise<InitialTurn[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from("messages")
    .select(
      "id, role, content, input_tokens, output_tokens, latency_ms, error_message, run_id",
    )
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as {
    id: string;
    role: string;
    content: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number | null;
    error_message: string | null;
    run_id: string | null;
  }[];

  // 0043:按 run_id 反查运行状态 —— 中断且可续的运行,刷新后
  // 「继续运行」按钮依然能恢复,不必手打「继续」触发从头搜索。
  const runIds = [...new Set(rows.map((r) => r.run_id).filter((x): x is string => !!x))];
  const runStates = new Map<string, { interrupted: boolean; resumable: boolean }>();
  if (runIds.length > 0) {
    const { data: runs } = await supabase
      .from("agent_runs")
      .select("id, status, resumable")
      .in("id", runIds);
    for (const run of runs ?? []) {
      runStates.set(run.id as string, {
        interrupted: run.status === "interrupted",
        resumable: run.resumable === true,
      });
    }
  }

  return rows.map((row) => {
    const state = row.run_id ? runStates.get(row.run_id) : undefined;
    return {
      id: row.id,
      role: row.role as "user" | "assistant",
      content: (row.content as string | null) ?? "",
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      error: row.error_message,
      runId: state?.interrupted && state.resumable ? (row.run_id ?? undefined) : undefined,
      resumable: state?.interrupted && state.resumable ? true : undefined,
    };
  });
}

/**
 * 这条会话产出的工作区文件。
 *
 * 给智能体页面的**产物预览弹出层**用:对话流里写文件那一行可以点开,
 * 全屏看完 Esc 关掉,对话区一寸都不让。
 *
 * (这个函数上一轮被删过一次 —— 当时右侧常驻产物栏被撤掉,它成了死代码。
 *  现在回来是因为有了真实用途:弹出层需要文件内容。)
 *
 * 工作区是用到时才建的(见 agent-turn.ts),所以没有工作区是正常状态,
 * 不是错误 —— 它只意味着这条会话还没有产出过文件。
 */
export async function loadWorkspaceForConversation(
  conversationId: string,
): Promise<{ id: string; name: string; files: WorkspaceFile[] } | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data: conv } = await supabase
    .from("conversations")
    .select("workspace_id")
    .eq("id", conversationId)
    .maybeSingle();

  const workspaceId = conv?.workspace_id as string | null | undefined;
  if (!workspaceId) return null;

  const [{ data: ws }, { data: files }] = await Promise.all([
    supabase.from("workspaces").select("id, name").eq("id", workspaceId).maybeSingle(),
    supabase
      .from("workspace_files")
      .select("path, content, size_chars, updated_at")
      .eq("workspace_id", workspaceId)
      .order("path"),
  ]);

  if (!ws) return null;

  return {
    id: ws.id as string,
    name: ws.name as string,
    files: (files ?? []).map((f) => ({
      path: f.path as string,
      content: (f.content as string | null) ?? "",
      sizeChars: (f.size_chars as number | null) ?? 0,
      updatedAt: f.updated_at as string,
    })),
  };
}
