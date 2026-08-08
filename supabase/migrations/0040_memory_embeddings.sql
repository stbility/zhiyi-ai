-- 0040 长期记忆:pgvector 向量召回
--
-- 依赖:pgvector 扩展(CI 迁移重放镜像已换 pgvector/pgvector:pg16)。
-- 维度钉死 1536(OpenAI text-embedding-3-small);换 embedding 模型维度
-- 不同时,需新迁移重建列与索引 —— 维度是 schema 契约,不悄悄改。
--
-- 人工确认门保持不变:记忆仍只从「用户确认沉淀 / 工作流产物沉淀」产生,
-- 向量只是召回排序手段,不是新的写入通道。
--
-- 未配置 embedding 服务时,embedding 列保持 NULL,召回自动降级为
-- 现有「最近优先」;配置后新沉淀的记忆才有向量,旧记忆可后续回填。

create extension if not exists vector;

alter table public.memories
  add column if not exists embedding vector(1536);

create index if not exists memories_embedding_idx
  on public.memories
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- 向量召回:按余弦相似度排序,只返回调用者组织内、且(组织级或本人)的记忆。
-- 与 get_entitlements 同一安全模型:函数体只认 auth.uid(),
-- 调用方传什么都绕不过组织与作用域过滤。
create or replace function public.search_memories(
  p_embedding vector(1536),
  p_limit integer default 8
) returns table (
  id uuid,
  organization_id uuid,
  category text,
  content text,
  source_type text,
  confidence numeric,
  scope text,
  recall_enabled boolean,
  last_used_at timestamptz,
  created_at timestamptz,
  similarity double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.organization_id, m.category, m.content, m.source_type,
         m.confidence, m.scope, m.recall_enabled, m.last_used_at, m.created_at,
         1 - (m.embedding <=> p_embedding) as similarity
  from public.memories m
  where m.embedding is not null
    and m.recall_enabled
    and private.is_org_member(m.organization_id)
    and (m.scope = 'organization' or m.created_by = (select auth.uid()))
  order by m.embedding <=> p_embedding
  limit p_limit;
$$;

revoke execute on function public.search_memories(vector(1536), integer) from public, anon;
grant execute on function public.search_memories(vector(1536), integer) to authenticated;
