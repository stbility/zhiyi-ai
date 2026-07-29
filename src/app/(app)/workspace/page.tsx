import type { Metadata } from "next";
import Link from "next/link";

import { WorkspaceBrowser, type WorkspaceFile } from "@/components/app/WorkspaceBrowser";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "工作区 · 智一 AI" };
export const dynamic = "force-dynamic";

interface WorkspaceGroup {
  id: string;
  name: string;
  files: WorkspaceFile[];
}

async function loadWorkspaces(
  organizationId: string,
): Promise<WorkspaceGroup[]> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return [];

  const [{ data: workspaces }, { data: files }] = await Promise.all([
    supabase
      .from("workspaces")
      .select("id, name, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
    supabase
      .from("workspace_files")
      .select("workspace_id, path, content, size_chars, updated_at")
      .eq("organization_id", organizationId)
      .order("path"),
  ]);

  const byWorkspace = new Map<string, WorkspaceFile[]>();
  for (const f of files ?? []) {
    const wid = f.workspace_id as string;
    const list = byWorkspace.get(wid) ?? [];
    list.push({
      path: f.path as string,
      content: f.content as string,
      sizeChars: (f.size_chars as number | null) ?? 0,
      updatedAt: f.updated_at as string,
    });
    byWorkspace.set(wid, list);
  }

  return (workspaces ?? []).map((w) => ({
    id: w.id as string,
    name: w.name as string,
    files: byWorkspace.get(w.id as string) ?? [],
  }));
}

export default async function WorkspacePage() {
  const organizations = await getMyOrganizations();
  const org = organizations[0];

  if (!org) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
        <h2 className="text-fg text-h2 font-zh mb-3 font-semibold">工作区</h2>
        <p className="text-fg-secondary font-zh text-caption">
          需要先创建组织。
        </p>
        <Link
          href="/today"
          className="text-brand hover:text-brand-hover font-zh text-caption mt-3 inline-block"
        >
          前往创建组织
        </Link>
      </div>
    );
  }

  const workspaces = await loadWorkspaces(org.id);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">工作区</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          智能体产出的文件都在这里,可以浏览和下载。
          在助手页开启「智能体」后,代码会直接写入工作区,而不是贴在回答里。
        </p>
      </header>

      {workspaces.length === 0 ? (
        <div className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
          <p className="text-fg text-body mb-1 font-medium">还没有工作区</p>
          <p className="text-fg-secondary text-caption">
            到「AI 助手」开启输入框下方的「智能体」开关,让它帮你写代码 ——
            产物会自动出现在这里。
          </p>
        </div>
      ) : (
        workspaces.map((w) => (
          <WorkspaceBrowser key={w.id} name={w.name} files={w.files} />
        ))
      )}
    </div>
  );
}
