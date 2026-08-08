import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logDbFailure } from "@/lib/log";

/**
 * 智能体记忆的数据访问层。
 *
 * 五条闭环的最后一环:「沉淀为记忆」。用户对一条回答点了「记住」,
 * 这条回答的核心内容就存成一条记忆,在后续对话里被召回。
 *
 * 来源纪律:用户确认的 (user_confirmed) 是唯一可信来源。
 * AI 推断的记忆 (ai_inferred) 必须带 confidence,且界面上不得伪装成
 * 用户确认的事实 —— 与营销页「每条记忆都标明来源」的承诺一致。
 */

export interface MemoryRow {
  id: string;
  organization_id: string;
  conversation_id: string | null;
  message_id: string | null;
  created_by: string;
  category: "fact" | "preference" | "convention" | "knowledge" | "persona";
  content: string;
  source_type: "user_confirmed" | "ai_inferred" | "from_file" | "from_workflow";
  confidence: number | null;
  scope: "organization" | "user";
  recall_enabled: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export type MemoryCategory = MemoryRow["category"];
export type MemorySourceType = MemoryRow["source_type"];

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "fact",
  "preference",
  "convention",
  "knowledge",
  "persona",
] as const;

/**
 * 沉淀一条用户确认的记忆。
 *
 * @param input.messageId   被确认的那条助手消息。取它的内容作为记忆正文。
 * @param input.category    记忆分类。用户选,不猜。
 * @param input.scope       组织级(默认)还是仅创建者可见。
 * @param input.customText  用户手动改写的版本。给了就用它,不给用消息原文。
 */
export async function saveMemory(
  supabase: SupabaseClient,
  input: {
    messageId: string;
    category: MemoryCategory;
    scope?: "organization" | "user" | undefined;
    customText?: string | undefined;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // 组织归属取自消息本身,不采信客户端 —— 否则记忆会落到别的组织名下,
  // 而记忆要在后续对话里按组织召回,归属错了就是跨组织泄露
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id, organization_id, conversation_id, content")
    .eq("id", input.messageId)
    .maybeSingle();

  if (messageError || !message) {
    logDbFailure("memories.message_lookup", messageError, {
      messageId: input.messageId,
    });
    return { ok: false, error: "找不到这条消息。" };
  }

  const content = (input.customText ?? (message.content as string)).trim();
  if (content === "") {
    return { ok: false, error: "这条消息没有可沉淀的内容。" };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "登录状态已失效,请重新登录。" };

  const { data: created, error } = await supabase
    .from("memories")
    .insert({
      organization_id: message.organization_id as string,
      conversation_id: message.conversation_id as string | null,
      message_id: input.messageId,
      created_by: user.id,
      category: input.category,
      content,
      source_type: "user_confirmed",
      // 用户确认的事实没有置信度 —— 用户的话就是事实
      confidence: null,
      scope: input.scope ?? "organization",
      recall_enabled: true,
    })
    .select("id")
    .single();

  if (error || !created) {
    logDbFailure("memories.insert", error, { messageId: input.messageId });
    return { ok: false, error: `未能保存记忆:${error?.message ?? "未知错误"}` };
  }

  // 沉淀的同时,把这条记忆写进工作区的 LLM Wiki(Karpathy 模式)。
  // Wiki 是互联的 markdown 文件:每条记忆一个页面,index.md 汇总。
  // 失败不影响记忆本身 —— wiki 同步是增强,不是承诺。
  await syncMemoryToWiki(supabase, {
    organizationId: message.organization_id as string,
    conversationId: message.conversation_id as string | null,
    memoryId: created.id as string,
    category: input.category,
    content,
    createdBy: user.id,
  }).catch((e: unknown) => {
    logDbFailure("memories.wiki_sync", e as { message: string }, {
      memoryId: created.id,
    });
  });

  return { ok: true, id: created.id as string };
}

/**
 * 把一条记忆同步为 wiki 页面。
 *
 * 目录结构(与 llm-wiki 技能对齐):
 *   wiki/memories/<category>/<memoryId>.md   — 记忆页面,frontmatter 齐全
 *   wiki/index.md                            — 汇总目录,追加一行
 *
 * 工作区不存在时跳过(智能体会话才有工作区;AI 助手会话没有,
 * 但记忆同样有意义 —— 记忆是组织资产,不依赖工作区存在)。
 */
async function syncMemoryToWiki(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    conversationId: string | null;
    memoryId: string;
    category: MemoryCategory;
    content: string;
    createdBy: string;
  },
): Promise<void> {
  // 找到这个组织默认/首个工作区。没有就不写 wiki ——
  // 不要为了写 wiki 去创建一个空工作区。
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("organization_id", input.organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!workspace) return;

  const wikiPath = `wiki/memories/${input.category}/${input.memoryId}.md`;
  const page = `---
title: ${input.content.split("\n")[0]?.slice(0, 60) ?? "记忆"}
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
type: memory
tags: [memory, ${input.category}]
source: user_confirmed
---

# ${input.content.split("\n")[0]?.slice(0, 60) ?? "记忆"}

${input.content}
`;

  await supabase.from("workspace_files").upsert(
    {
      workspace_id: workspace.id as string,
      organization_id: input.organizationId,
      path: wikiPath,
      content: page,
      size_chars: page.length,
      written_by_conversation: input.conversationId ?? undefined,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,path" },
  );

  // 更新 index.md:读取现有内容,追加一行。读不到就当空目录。
  const { data: existing } = await supabase
    .from("workspace_files")
    .select("content")
    .eq("workspace_id", workspace.id as string)
    .eq("path", "wiki/index.md")
    .maybeSingle();

  const prev = (existing?.content as string | undefined) ?? "";
  const line = `- [[${input.memoryId}]] — ${input.category}: ${input.content
    .split("\n")[0]
    ?.slice(0, 80) ?? ""}`;
  const next = prev.includes(`[[${input.memoryId}]]`)
    ? prev
    : `${prev}${prev.endsWith("\n") || prev === "" ? "" : "\n"}${line}\n`;

  await supabase.from("workspace_files").upsert(
    {
      workspace_id: workspace.id as string,
      organization_id: input.organizationId,
      path: "wiki/index.md",
      content: next,
      size_chars: next.length,
      written_by_conversation: input.conversationId ?? undefined,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,path" },
  );
}

/**
 * 召回本组织的记忆,按最近使用优先。
 *
 * 走 RPC:服务端装配上下文时用,不走客户端查询。
 * 客户端查了也没用 —— 召回发生在服务端,用户看到的是已经带进上下文的回答。
 */
/**
 * 工作流产物沉淀为记忆(闭环最后一环)。
 *
 * 与 saveMemory 的区别:工作流步骤没有 messageId —— 产物来自运行输出,
 * source_type 固定为 from_workflow(设计系统徽章语义:从工作流生成),
 * 归组织级、可召回。沉淀失败只记日志,不阻断工作流本身 ——
 * 运行已经完成,记忆是增强不是承诺(与 wiki 同步同一哲学)。
 */
export const WORKFLOW_MEMORY_MAX_CHARS = 2000;

/** 纯函数:把工作流步骤输出截成可入库的记忆正文(可单测) */
export function buildWorkflowMemoryContent(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= WORKFLOW_MEMORY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, WORKFLOW_MEMORY_MAX_CHARS)}…(截断)`;
}

export async function saveWorkflowMemory(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    createdBy: string;
    content: string;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const content = buildWorkflowMemoryContent(input.content);
  if (content === "") {
    return { ok: false, error: "没有可沉淀的产物内容。" };
  }

  const { data: created, error } = await supabase
    .from("memories")
    .insert({
      organization_id: input.organizationId,
      conversation_id: null,
      message_id: null,
      created_by: input.createdBy,
      category: "knowledge",
      content,
      source_type: "from_workflow",
      confidence: null,
      scope: "organization",
      recall_enabled: true,
    })
    .select("id")
    .single();

  if (error || !created) {
    logDbFailure("memories.workflow_insert", error, {
      organizationId: input.organizationId,
    });
    return { ok: false, error: `未能沉淀工作流记忆:${error?.message ?? "未知错误"}` };
  }

  // 与对话记忆同一待遇:同步进 LLM Wiki。失败不影响记忆本身。
  await syncMemoryToWiki(supabase, {
    organizationId: input.organizationId,
    conversationId: null,
    memoryId: created.id as string,
    category: "knowledge",
    content,
    createdBy: input.createdBy,
  }).catch((e) => {
    logDbFailure("memories.workflow_wiki_sync", e instanceof Error ? e : undefined);
  });

  return { ok: true, id: created.id as string };
}

export async function recallMemories(
  supabase: SupabaseClient,
  organizationId: string,
  limit = 10,
): Promise<MemoryRow[]> {
  const { data, error } = await supabase.rpc("recall_memories", {
    p_organization_id: organizationId,
    p_limit: limit,
  });

  if (error) {
    logDbFailure("memories.recall", error, { organizationId });
    return [];
  }
  return (data ?? []) as MemoryRow[];
}

/** 记录一次成功召回,让召回按使用频率自适应排序 */
export async function touchMemory(
  supabase: SupabaseClient,
  memoryId: string,
): Promise<void> {
  await supabase.rpc("touch_memory", { p_memory_id: memoryId }).then(
    () => undefined,
    (e: unknown) => {
      logDbFailure("memories.touch", e as { message: string }, { memoryId });
    },
  );
}

/** 列出本组织的记忆(记忆管理页用) */
export async function listMemories(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<MemoryRow[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    logDbFailure("memories.list", error, { organizationId });
    return [];
  }
  return (data ?? []) as MemoryRow[];
}

/** 删除一条记忆。只有创建者能删(RLS 已挡,这里只是返回友好错误) */
export async function deleteMemory(
  supabase: SupabaseClient,
  memoryId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("memories")
    .delete()
    .eq("id", memoryId);

  if (error) {
    logDbFailure("memories.delete", error, { memoryId });
    return { ok: false, error: `未能删除记忆:${error.message}` };
  }
  return { ok: true };
}

/** 切换某条记忆是否参与召回 */
export async function setMemoryRecall(
  supabase: SupabaseClient,
  memoryId: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("memories")
    .update({ recall_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("id", memoryId);

  if (error) {
    logDbFailure("memories.set_recall", error, { memoryId });
    return { ok: false, error: `操作失败:${error.message}` };
  }
  return { ok: true };
}
