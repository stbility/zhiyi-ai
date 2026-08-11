import type { Metadata } from "next";

import {
  KnowledgeManager,
  type KnowledgeRow,
} from "@/components/app/KnowledgeManager";
import type { KnowledgeFileStatus } from "@/components/knowledge/KnowledgeFileRow";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { KnowledgeFileType } from "@/lib/knowledge/parse";

export const metadata: Metadata = { title: "知识库 · 智一 AI" };
export const dynamic = "force-dynamic";

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const organizations = await getMyOrganizations();
  const organization = organizations?.[0];
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  let files: KnowledgeRow[] = [];

  if (supabase && organization) {
    let query = supabase
      .from("knowledge_files")
      .select("id, name, file_type, size_bytes, status, error, created_by, created_at, updated_at, content_text")
      .eq("organization_id", organization.id);

    const keyword = q?.trim();
    if (keyword) {
      // 检索:名称或正文匹配关键词(ready 文件才有正文)
      query = query.or(`name.ilike.%${keyword}%,content_text.ilike.%${keyword}%`);
    }

    const { data } = await query.order("created_at", { ascending: false }).limit(100);

    files = ((data ?? []) as unknown[]).map((row) => {
      const r = row as {
        id: string;
        name: string;
        file_type: string;
        size_bytes: number;
        status: string;
        error: string | null;
        created_by: string;
        created_at: string;
        updated_at: string;
        content_text: string | null;
      };
      return {
        id: r.id,
        name: r.name,
        fileType: r.file_type as KnowledgeFileType,
        sizeBytes: r.size_bytes,
        status: (r.status as KnowledgeFileStatus) ?? "uploading",
        error: r.error,
        mine: r.created_by === user?.id,
        createdAt: r.created_at,
        contentText: r.content_text ?? "",
      };
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">知识库</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          上传 pdf / docx / md / txt,解析后供智能体检索使用。v1 为全文检索,
          向量检索待 embedding 服务接入。
        </p>
      </header>

      <KnowledgeManager files={files} initialQuery={q ?? ""} />
    </div>
  );
}
