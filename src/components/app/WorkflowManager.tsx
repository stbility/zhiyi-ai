"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { WorkflowCard } from "@/components/workflow/WorkflowCard";
import { WorkflowStatusBadge, type WorkflowStatus } from "@/components/workflow/WorkflowStatusBadge";
import { WorkflowTimeline } from "@/components/workflow/WorkflowTimeline";
import { Button, Checkbox, Input, TextArea } from "@/components/primitives";
import {
  approveWorkflowStep,
  cancelWorkflow,
  createWorkflow,
  deleteWorkflow,
  markReady,
  pauseWorkflow,
  resumeWorkflow,
  runWorkflow,
  updateWorkflow,
} from "@/app/(app)/workflow/actions";
import type { WorkflowStep } from "@/lib/workflow/state-machine";

export interface WorkflowRow {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly status: WorkflowStatus;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly agents?: readonly string[] | undefined;
  readonly currentStep?: string | undefined;
}

export interface RunRow {
  readonly id: string;
  readonly status: WorkflowStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly steps: {
    stepId: string;
    title: string;
    output?: string;
    error?: string;
    agent?: string;
    status?: WorkflowStatus;
  }[];
}

export interface WorkflowDetail extends WorkflowRow {
  readonly steps: readonly WorkflowStep[];
  readonly runs: readonly RunRow[];
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function newStep(): WorkflowStep {
  return { id: crypto.randomUUID().slice(0, 8), title: "", prompt: "" };
}

export function WorkflowManager({
  workflows,
  selected,
  canEdit,
}: {
  workflows: readonly WorkflowRow[];
  selected: WorkflowDetail | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* 左侧:工作流列表 */}
      <div className="flex flex-col gap-2">
        <Button size="sm" onClick={() => setCreating(true)}>
          新建工作流
        </Button>
        {workflows.map((w) => (
          <WorkflowCard
            key={w.id}
            name={w.name}
            goal={w.goal || undefined}
            status={w.status}
            currentStep={w.currentStep}
            agents={w.agents ?? []}
            lastRun={formatTime(w.updatedAt)}
            onOpen={() => {
              void router.replace(`/workflow?id=${w.id}`);
            }}
          />
        ))}
        {workflows.length === 0 && !creating && (
          <p className="border-border-default rounded-control text-fg-secondary font-zh text-caption border border-dashed p-4">
            还没有工作流。点击「新建工作流」编排第一步。
          </p>
        )}
      </div>

      {/* 右侧:详情 / 新建(用 key 重挂载,状态从 props 初始化,不靠 effect 同步) */}
      <div className="flex min-w-0 flex-col gap-4">
        {creating ? (
          <WorkflowForm
            key="create"
            initialName=""
            initialGoal=""
            initialSteps={[newStep()]}
            submitLabel="创建"
            busyLabel="创建中…"
            onSubmit={async (name, goal, steps) =>
              createWorkflow(name, goal || undefined, steps)
            }
            onCancel={() => setCreating(false)}
            onSaved={() => setCreating(false)}
          />
        ) : selected ? (
          <WorkflowDetailPanel key={selected.id} detail={selected} canEdit={canEdit} />
        ) : (
          <p className="border-border-default rounded-control text-fg-secondary font-zh text-caption border border-dashed p-4">
            选择左侧工作流查看详情,或新建一个。
          </p>
        )}
      </div>
    </div>
  );
}

/** 工作流详情面板(创建者编辑 + 运行历史) */
function WorkflowDetailPanel({
  detail,
  canEdit,
}: {
  detail: WorkflowDetail;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(detail.name);
  const [goal, setGoal] = useState(detail.goal);
  const [steps, setSteps] = useState<readonly WorkflowStep[]>(detail.steps);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const editing = canEdit && (detail.status === "DRAFT" || detail.status === "READY");

  async function act(key: string, action: () => Promise<{ ok?: string; error?: string }>) {
    setPending(key);
    setError(null);
    setOk(null);
    const result = await action();
    if (result.error) setError(result.error);
    else setOk(result.ok ?? "完成。");
    setPending(null);
    startTransition(() => router.refresh());
  }

  async function save() {
    if (steps.length === 0) {
      setError("至少需要一个步骤。");
      return;
    }
    setPending("save");
    setError(null);
    setOk(null);
    const result = await updateWorkflow(detail.id, name, goal || undefined, [...steps]);
    if (result.error) setError(result.error);
    else setOk(result.ok ?? "已保存。");
    setPending(null);
    startTransition(() => router.refresh());
  }

  const selectedRun =
    detail.runs.find((r) => r.id === selectedRunId) ?? detail.runs[0] ?? null;

  const actions: { key: string; label: string; run: () => Promise<{ ok?: string; error?: string }> }[] =
    [];
  if (detail.status === "DRAFT") actions.push({ key: "ready", label: "就绪", run: () => markReady(detail.id) });
  if (detail.status === "READY") {
    actions.push({ key: "run", label: "运行", run: () => runWorkflow(detail.id) });
    actions.push({ key: "pause", label: "暂停", run: () => pauseWorkflow(detail.id) });
  }
  if (detail.status === "PAUSED") {
    actions.push({ key: "resume", label: "恢复", run: () => resumeWorkflow(detail.id) });
    actions.push({ key: "cancel", label: "取消", run: () => cancelWorkflow(detail.id) });
  }
  if (detail.status === "FAILED") {
    actions.push({ key: "run", label: "重试", run: () => runWorkflow(detail.id) });
    actions.push({ key: "cancel", label: "取消", run: () => cancelWorkflow(detail.id) });
  }
  if (!["RUNNING", "COMPLETED"].includes(detail.status)) {
    actions.push({ key: "delete", label: "删除", run: () => deleteWorkflow(detail.id) });
  }

  return (
    <>
      <section className="bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-3 border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-fg text-body font-medium">{detail.name}</h3>
            <WorkflowStatusBadge status={detail.status} />
          </div>
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button
                key={a.key}
                size="sm"
                variant={a.key === "run" ? "primary" : "secondary"}
                disabled={pending !== null}
                onClick={() => void act(a.key, a.run)}
              >
                {pending === a.key ? "处理中…" : a.label}
              </Button>
            ))}
            {!canEdit && (
              <span className="text-fg-tertiary text-label self-center">
                仅创建者可编辑/运行
              </span>
            )}
          </div>
        </div>

        {detail.goal && <p className="text-fg-secondary text-caption">{detail.goal}</p>}

        {error && (
          <p className="border-error-tint bg-error-tint text-error rounded-control text-caption p-3">
            {error}
          </p>
        )}
        {ok && (
          <p className="border-success-tint bg-success-tint text-success rounded-control text-caption p-3">
            {ok}
          </p>
        )}

        {editing ? (
          <>
            <WorkflowEditor
              name={name}
              goal={goal}
              steps={steps}
              onName={setName}
              onGoal={setGoal}
              onSteps={setSteps}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={pending !== null} onClick={() => void save()}>
                {pending === "save" ? "保存中…" : "保存(回到草稿)"}
              </Button>
            </div>
          </>
        ) : (
          <WorkflowTimeline
            steps={detail.steps.map((s) => ({
              id: s.id,
              title: s.title,
              agent: s.agent,
            }))}
          />
        )}
      </section>

      {/* 运行历史 */}
      {detail.runs.length > 0 && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-3 border p-5">
          <h3 className="text-fg text-body font-medium">运行历史</h3>
          <div className="flex flex-wrap gap-1.5">
            {detail.runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={
                  selectedRun?.id === run.id
                    ? "bg-brand-tint text-brand rounded-tag text-label px-2 py-1 font-medium"
                    : "bg-surface-3 text-fg-tertiary rounded-tag text-label px-2 py-1"
                }
              >
                {formatTime(run.startedAt)}
                <WorkflowStatusBadge status={run.status} />
              </button>
            ))}
          </div>

          {selectedRun && (
            <div className="flex flex-col gap-2">
              <WorkflowTimeline
                steps={selectedRun.steps.map((s, i) => ({
                  id: s.stepId,
                  title: s.title,
                  agent: s.agent,
                  status: s.status ?? (s.error ? "FAILED" : i === selectedRun.steps.length - 1 ? selectedRun.status : "COMPLETED"),
                }))}
              />
              {selectedRun.error && (
                <p className="border-error-tint bg-error-tint text-error rounded-control text-caption p-3">
                  {selectedRun.error}
                </p>
              )}

              {selectedRun.status === "WAITING_FOR_APPROVAL" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={pending !== null}
                    onClick={() =>
                      void act("approve", () =>
                        approveWorkflowStep(detail.id, selectedRun.id, true),
                      )
                    }
                  >
                    {pending === "approve" ? "处理中…" : "批准,继续执行"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending !== null}
                    onClick={() =>
                      void act("reject", () =>
                        approveWorkflowStep(detail.id, selectedRun.id, false),
                      )
                    }
                  >
                    {pending === "reject" ? "处理中…" : "拒绝,取消本次运行"}
                  </Button>
                </div>
              )}

              {selectedRun.steps.map((s) => (
                <details key={s.stepId} className="text-caption">
                  <summary className="text-fg-secondary cursor-pointer">
                    {s.title} 的输出
                  </summary>
                  <pre className="text-fg-secondary bg-surface-3 mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-control p-3 text-[12px]">
                    {s.error ?? s.output ?? (s.status === "WAITING_FOR_APPROVAL" ? "等待确认,尚未执行" : "无输出")}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** 新建表单(与编辑共用编辑器) */
function WorkflowForm({
  initialName,
  initialGoal,
  initialSteps,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
  onSaved,
}: {
  initialName: string;
  initialGoal: string;
  initialSteps: readonly WorkflowStep[];
  submitLabel: string;
  busyLabel: string;
  onSubmit: (
    name: string,
    goal: string | undefined,
    steps: readonly WorkflowStep[],
  ) => Promise<{ ok?: string; error?: string }>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [goal, setGoal] = useState(initialGoal);
  const [steps, setSteps] = useState<readonly WorkflowStep[]>(initialSteps);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function save() {
    if (steps.length === 0) {
      setError("至少需要一个步骤。");
      return;
    }
    setPending(true);
    setError(null);
    setOk(null);
    const result = await onSubmit(name, goal || undefined, steps);
    if (result.error) setError(result.error);
    else {
      setOk(result.ok ?? "已保存。");
      onSaved();
    }
    setPending(false);
    startTransition(() => router.refresh());
  }

  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh flex flex-col gap-3 border p-5">
      <h3 className="text-fg text-body font-medium">新建工作流</h3>
      {error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control text-caption p-3">
          {error}
        </p>
      )}
      {ok && (
        <p className="border-success-tint bg-success-tint text-success rounded-control text-caption p-3">
          {ok}
        </p>
      )}
      <WorkflowEditor
        name={name}
        goal={goal}
        steps={steps}
        onName={setName}
        onGoal={setGoal}
        onSteps={setSteps}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => void save()}>
          {pending ? busyLabel : submitLabel}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={onCancel}>
          取消
        </Button>
      </div>
    </section>
  );
}

function WorkflowEditor({
  name,
  goal,
  steps,
  onName,
  onGoal,
  onSteps,
}: {
  name: string;
  goal: string;
  steps: readonly WorkflowStep[];
  onName: (v: string) => void;
  onGoal: (v: string) => void;
  onSteps: (v: readonly WorkflowStep[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Input label="名称" value={name} onChange={onName} />
      <Input
        label="目标(可选)"
        value={goal}
        onChange={onGoal}
        placeholder="这个工作流要完成什么?"
      />
      <div className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <div key={step.id} className="bg-surface-3 rounded-control flex flex-col gap-2 border p-3">
            <div className="flex items-center gap-2">
              <span className="text-fg-tertiary text-label shrink-0">步骤 {index + 1}</span>
              <Input
                aria-label={`步骤 ${index + 1} 标题`}
                value={step.title}
                onChange={(title) => {
                  const next = [...steps];
                  next[index] = { ...step, title };
                  onSteps(next);
                }}
                placeholder="标题,如:整理本周会议纪要"
              />
              <Input
                aria-label={`步骤 ${index + 1} Agent`}
                value={step.agent ?? ""}
                onChange={(agent) => {
                  const next = [...steps];
                  next[index] = { ...step, agent: agent || undefined };
                  onSteps(next);
                }}
                placeholder="Agent 名(可选)"
                className="w-32"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={steps.length <= 1}
                onClick={() => onSteps(steps.filter((s) => s.id !== step.id))}
              >
                删除
              </Button>
            </div>
            <div className="flex items-center gap-4">
              <Checkbox
                checked={step.needsApproval === true}
                onChange={(checked) => {
                  const next = [...steps];
                  next[index] = { ...step, needsApproval: checked || undefined };
                  onSteps(next);
                }}
                label="需要人工确认(执行到此处停下等待批准)"
              />
            </div>
            <TextArea
              value={step.prompt}
              onChange={(prompt) => {
                const next = [...steps];
                next[index] = { ...step, prompt };
                onSteps(next);
              }}
              rows={3}
              placeholder="给智能体的指令,如:读取 /workspace 下的会议记录,输出结构化要点"
            />
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => onSteps([...steps, newStep()])}>
          添加步骤
        </Button>
      </div>
    </div>
  );
}
