-- 0070 长期记忆 embeddings 升级:NVIDIA Nemotron 2048 维
--
-- 【背景】
-- Phase 5 基线从 OpenAI text-embedding-3-small(1536 维)升级为
-- NVIDIA nvidia/nemotron-3-embed-1b(2048 维,官方免费端口,
-- 不支持降维,passage/query 必须区分 input_type)。
--
-- 生产数据量极小(审计:4 条 memories,embedding 全 NULL),
-- 一次性迁移零回填负担。
--
-- 【不修改历史迁移】0040/0046 保持原样;本迁移在它们之后叠加覆盖。
--
-- 变更:
--   1. memories.embedding → vector(2048)
--   2. 重建 HNSW 索引(维度随列,drop + create 保险)
--   3. search_memories 重建为 extensions.vector(2048) 签名
--   4. GRANT/REVOKE 签名同步(extensions.vector(2048) 与 2048 显式签名)

-- 1. 先 drop 旧 HNSW 索引(0040 建的 1536 维):
--    pgvector 在 alter column 类型时若旧 HNSW 索引仍在,会尝试转换
--    并触发 2000 维上限检查(实证:column cannot have more than 2000
--    dimensions for hnsw index)。必须先删索引,再改类型。
drop index if exists public.memories_embedding_idx;

-- 2. 列升级 1536 → 2048
-- ⚠️ 0046 已把 vector 扩展移入 extensions schema,裸 vector 类型不可见,
--    必须用 extensions.vector(与 search_memories 函数体一致)。
alter table public.memories
  alter column embedding type extensions.vector(2048);

-- 3. 索引:p gvector 所有索引(HNSW/IVFFlat)有 2000 维硬上限,
--    Nemotron 2048 维无法建索引 —— 不建索引。
--    生产数据量极小(4 条),顺序扫描 + extensions.<=> 毫秒级;
--    数据增长后再评估(如降维方案或换索引兼容模型)。
--    (注意:旧 memories_embedding_idx 已在步骤 1 drop,不再重建)

-- 3. search_memories 重建为 2048 维(继承 0046 的 extensions 限定 +
--    security invoker + search_path='' 全部保留,仅维度变更)
create or replace function public.search_memories(
  p_embedding extensions.vector(2048),
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
security invoker
set search_path = ''
as $$
  select m.id, m.organization_id, m.category, m.content, m.source_type,
         m.confidence, m.scope, m.recall_enabled, m.last_used_at, m.created_at,
         1 - (m.embedding OPERATOR(extensions.<=>) p_embedding) as similarity
  from public.memories m
  where m.embedding is not null
    and m.recall_enabled
    and private.is_org_member(m.organization_id)
    and (m.scope = 'organization' or m.created_by = (select auth.uid()))
  order by m.embedding OPERATOR(extensions.<=>) p_embedding
  limit p_limit;
$$;

-- 4. 权限签名同步(先 revoke 旧 1536 签名,再 grant 2048;
--    0046 已把 vector 移入 extensions,裸 vector 签名不存在,只 revoke
--    extensions.vector 形式)
revoke execute on function public.search_memories(extensions.vector, integer) from public, anon;
revoke execute on function public.search_memories(extensions.vector(1536), integer) from public, anon;
grant execute on function public.search_memories(extensions.vector(2048), integer) to authenticated;
