import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const M0038 = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0038_knowledge_files.sql"),
  "utf8",
);

describe("0038 知识库迁移", () => {
  it("knowledge_files 表存在,状态机与设计系统 5 态一致", () => {
    expect(M0038).toContain("create table if not exists public.knowledge_files");
    expect(M0038).toContain("'uploading','parsing','indexing','ready','failed'");
  });

  it("支持的文件类型白名单与解析层一致", () => {
    expect(M0038).toMatch(/file_type\s+text not null check \(file_type in \('pdf','docx','md','txt','other'\)\)/);
  });

  it("RLS 已启用:成员可读,创建者本人可改/删", () => {
    expect(M0038).toMatch(/enable row level security/);
    expect(M0038).toContain("knowledge_files_select_member");
    expect(M0038).toContain("knowledge_files_update_own");
    expect(M0038).toContain("knowledge_files_delete_own");
  });

  it("组织索引与正文列齐备", () => {
    expect(M0038).toContain("knowledge_files_org_idx");
    expect(M0038).toMatch(/content_text\s+text not null default ''/);
  });
});
