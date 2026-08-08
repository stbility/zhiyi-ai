import type { Metadata } from "next";

import {
  WorkflowManager,
  type WorkflowDetail,
  type WorkflowRow,
} from "@/components/app/WorkflowManager";
import type { WorkflowStatus } from "@/components/workflow/WorkflowStatusBadge";
import { getMyOrganizations } from "@/lib/db/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseDefinition, type WorkflowStep } from "@/lib/workflow/state-machine";

export const metadata: Metadata = { title: "工作流 · 智一 AI" };
export const dynamic = "force-dynamic";
// 运行动作要串行执行最多 5 步(每步 45s 超时),预留整个函数预算
export const maxDuration = 300;

interface RunRow {
  readonly id: string;
  readonly status: WorkflowStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly steps: { stepId: string; title: string; output?: string; error?: string }[];
}

function parseSteps(raw: unknown): WorkflowStep[] {
  try {
    return parseDefinition(raw).steps as readonly WorkflowStep[] as WorkflowStep[];
  } catch {
    return [];
  }
}

function parseRunOutput(raw: unknown): RunRow["steps"] {
  if (typeof raw !== "object" || raw === null) return [];
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps as RunRow["steps"];
}

export default async function WorkflowPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id: selectedId } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const organizations = await getMyOrganizations();
  const organization = organizations?.[0];
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  let workflows: WorkflowRow[] = [];
  let selected: WorkflowDetail | null = null;

  if (supabase && organization) {
    const { data } = await supabase
      .from("workflows")
      .select("id, name, goal, status, created_by, updated_at")
      .eq("organization_id", organization.id)
      .order("updated_at", { ascending: false })
      .limit(100);

    workflows = (data ?? []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      goal: (row.goal as string) ?? "",
      status: (row.status as WorkflowStatus) ?? "DRAFT",
      createdBy: row.created_by as string,
      updatedAt: row.updated_at as string,
    }));

    const target = workflows.find((w) => w.id === selectedId) ?? workflows[0] ?? null;
    if (target) {
      const { data: full } = await supabase
        .from("workflows")
        .select("name, goal, status, definition, created_by, updated_at")
        .eq("id", target.id)
        .maybeSingle();
      const { data: runs } = await supabase
        .from("workflow_runs")
        .select("id, status, started_at, finished_at, error, output")
        .eq("workflow_id", target.id)
        .order("created_at", { ascending: false })
        .limit(20);

      if (full) {
        selected = {
          id: target.id,
          name: full.name as string,
          goal: (full.goal as string) ?? "",
          status: (full.status as WorkflowStatus) ?? "DRAFT",
          createdBy: full.created_by as string,
          updatedAt: full.updated_at as string,
          steps: parseSteps(full.definition),
          runs: ((runs ?? []) as unknown[]).map((r) => {
            const row = r as {
              id: string;
              status: string;
              started_at: string | null;
              finished_at: string | null;
              error: string | null;
              output: unknown;
            };
            return {
              id: row.id,
              status: (row.status as WorkflowStatus) ?? "QUEUED",
              startedAt: row.started_at,
              finishedAt: row.finished_at,
              error: row.error,
              steps: parseRunOutput(row.output),
            } satisfies RunRow;
          }),
        };
      }
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">工作流</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          把多步任务编排成可重复运行的工作流:每个步骤通过智能体执行,运行记录留痕。
          v1 为同步执行(单次最多 5 步),后台 Worker 排队执行后续上线。
        </p>
      </header>

      <WorkflowManager
        workflows={workflows}
        selected={selected}
        canEdit={selected !== null && selected.createdBy === user?.id}
      />
    </div>
  );
}
