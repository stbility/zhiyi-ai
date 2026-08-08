import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const M0040 = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0040_memory_embeddings.sql"),
  "utf8",
);

describe("0040 长期记忆向量层", () => {
  it("pgvector 扩展 + memories.embedding 列 + HNSW 索引", () => {
    expect(M0040).toContain("create extension if not exists vector");
    expect(M0040).toMatch(/add column if not exists embedding vector\(1536\)/);
    expect(M0040).toMatch(/using hnsw \(embedding vector_cosine_ops\)/);
  });

  it("search_memories 按余弦相似度召回,security definer + 组织过滤", () => {
    expect(M0040).toContain("create or replace function public.search_memories");
    expect(M0040).toMatch(/OPERATOR\(public\.<=>\)/);
    expect(M0040).toContain("security definer");
    expect(M0040).toContain("private.is_org_member(m.organization_id)");
    // 作用域纪律:组织级或本人,与 0028 select 策略一致
    expect(M0040).toMatch(/m\.scope = 'organization' or m\.created_by = \(select auth\.uid\(\)\)/);
  });

  it("EXECUTE 只给 authenticated", () => {
    expect(M0040).toMatch(/revoke execute on function public\.search_memories\(vector\(1536\), integer\) from public, anon/);
    expect(M0040).toMatch(/grant execute on function public\.search_memories\(vector\(1536\), integer\) to authenticated/);
  });
});
