"use client";

import { useActionState, useState } from "react";

import { StatusLabel } from "@/components/primitives/StatusLabel";
import { Button } from "@/components/primitives/Button";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import { Switch } from "@/components/primitives/Switch";
import {
  deleteSkill,
  importSkill,
  saveSkill,
  toggleSkill,
  type SkillState,
} from "@/app/(app)/settings/skills/skills-actions";

/**
 * 技能库管理。
 *
 * 对齐 Hermes 的 SKILL.md 规范:导入一份标准 SKILL.md(frontmatter +
 * 正文),产品端的 skill_list / skill_view 就能像 Hermes 一样按需加载它。
 *
 * 界面纪律:
 *   1. 导入是粘贴 SKILL.md 全文,解析失败给出能照着改的错误
 *   2. 启停/删除一眼可达;停用保留内容,删除连附件一起清掉
 *   3. 描述字段就是 agent 判断「何时加载」的依据,如实展示
 *   4. 0042 起组织成员可编辑:页内编辑器直接改正文,不用懂 frontmatter
 */

export interface SkillRow {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  tags: string[];
  body: string;
  enabled: boolean;
  createdAt: string;
  fileCount: number;
}

function SkillTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="text-fg-tertiary text-label">
      {tags.map((t) => `#${t}`).join(" ")}
    </span>
  );
}

export function SkillsManager({
  organizationId,
  skills,
  canManage,
}: {
  organizationId: string;
  skills: readonly SkillRow[];
  canManage: boolean;
}) {
  const [importState, importAction] = useActionState<SkillState, FormData>(
    importSkill,
    {},
  );
  const [toggleState, toggleAction] = useActionState<SkillState, FormData>(
    toggleSkill,
    {},
  );
  const [deleteState, deleteAction] = useActionState<SkillState, FormData>(
    deleteSkill,
    {},
  );
  const [saveState, saveAction] = useActionState<SkillState, FormData>(
    saveSkill,
    {},
  );

  const [markdown, setMarkdown] = useState("");
  // null = 不显示编辑器;"new" = 新建;SkillRow = 编辑该技能
  const [editing, setEditing] = useState<SkillRow | "new" | null>(null);

  const enabledCount = skills.filter((s) => s.enabled).length;
  const feedback = importState.error
    ? importState
    : toggleState.error
      ? toggleState
      : deleteState.error
        ? deleteState
        : saveState.error
          ? saveState
          : importState.ok
            ? importState
            : toggleState.ok
              ? toggleState
              : saveState.ok
                ? saveState
                : deleteState.ok
                  ? deleteState
                  : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <h2 className="text-fg text-h2 font-zh font-semibold">技能库</h2>
        <p className="text-fg-secondary font-zh text-caption mt-2">
          对齐 Hermes 的 SKILL 规范 —— 同一份技能文件,这里和 Hermes 两端都能跑。
          智能体遇到任务先 skill_list 看有什么,再 skill_view 加载需要的。
        </p>
      </header>

      <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h3 className="text-fg text-body font-medium">技能</h3>
          {skills.length > 0 ? (
            <StatusLabel tone="success">{`${enabledCount}/${skills.length} 启用`}</StatusLabel>
          ) : (
            <StatusLabel>空</StatusLabel>
          )}
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setEditing("new")}
            >
              + 新建技能
            </Button>
          )}
        </div>

        {skills.length > 0 && (
          <ul className="mb-4 flex flex-col gap-2">
            {skills.map((s) => (
              <li
                key={s.id}
                className="border-border-default bg-surface-3 rounded-control flex flex-wrap items-center gap-3 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-fg text-label font-medium font-mono">
                      {s.name}
                    </span>
                    <span className="text-fg-tertiary text-label">
                      v{s.version}
                    </span>
                    {!s.enabled && <StatusLabel>已停用</StatusLabel>}
                  </div>
                  <p className="text-fg-secondary text-label mt-0.5">
                    {s.description}
                  </p>
                  <p className="text-fg-tertiary text-label mt-0.5">
                    {s.title}
                    {s.fileCount > 0 ? ` · ${s.fileCount} 个附件` : ""}
                    <SkillTags tags={s.tags} />
                  </p>
                </div>

                {canManage && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(s)}
                    >
                      编辑
                    </Button>
                    <form action={toggleAction} className="flex items-center">
                      <input type="hidden" name="id" value={s.id} />
                      <input
                        type="hidden"
                        name="organizationId"
                        value={organizationId}
                      />
                      <button
                        type="submit"
                        className="flex cursor-pointer items-center"
                        aria-label={s.enabled ? "停用" : "启用"}
                      >
                        <Switch
                          checked={s.enabled}
                          label={s.enabled ? "停用" : "启用"}
                        />
                      </button>
                    </form>

                    <form action={deleteAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input
                        type="hidden"
                        name="organizationId"
                        value={organizationId}
                      />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        className="text-error"
                      >
                        删除
                      </Button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {skills.length === 0 && (
          <p className="text-fg-tertiary text-caption mb-4">
            还没有技能。从 Hermes 的 skills 目录复制一份 SKILL.md 粘贴到下面导入,
            或自己写一份。
          </p>
        )}

        {editing !== null && canManage && (
          <form
            action={saveAction}
            className="border-brand/40 bg-surface-3 rounded-control mb-4 flex flex-col gap-3 border p-4"
          >
            <div className="flex items-center justify-between">
              <h4 className="text-fg text-label font-medium">
                {editing === "new" ? "新建技能" : `编辑 ${editing.name}`}
              </h4>
              <button
                type="button"
                className="text-fg-tertiary text-caption hover:text-fg"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
            </div>

            {editing !== "new" && (
              <input type="hidden" name="id" value={editing.id} />
            )}
            <input type="hidden" name="organizationId" value={organizationId} />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-fg-secondary text-label flex flex-col gap-1">
                技能名(slug,小写字母/数字/连字符)
                <input
                  name="name"
                  defaultValue={editing === "new" ? "" : editing.name}
                  disabled={editing !== "new"}
                  required
                  pattern="[a-z0-9][a-z0-9-_]*"
                  placeholder="weekly-report"
                  className="border-border-default bg-surface-2 text-fg rounded-control border px-3 py-2 font-mono text-caption"
                />
              </label>
              <label className="text-fg-secondary text-label flex flex-col gap-1">
                标题
                <input
                  name="title"
                  defaultValue={editing === "new" ? "" : editing.title}
                  required
                  placeholder="周报生成"
                  className="border-border-default bg-surface-2 text-fg rounded-control border px-3 py-2 text-caption"
                />
              </label>
            </div>

            <label className="text-fg-secondary text-label flex flex-col gap-1">
              触发条件(agent 据此判断何时加载这个技能)
              <input
                name="description"
                defaultValue={editing === "new" ? "" : editing.description}
                required
                placeholder="Use when generating a weekly report."
                className="border-border-default bg-surface-2 text-fg rounded-control border px-3 py-2 text-caption"
              />
            </label>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-fg-secondary text-label flex flex-col gap-1">
                版本
                <input
                  name="version"
                  defaultValue={editing === "new" ? "1.0.0" : editing.version}
                  className="border-border-default bg-surface-2 text-fg rounded-control border px-3 py-2 font-mono text-caption"
                />
              </label>
              <label className="text-fg-secondary text-label flex flex-col gap-1">
                标签(逗号分隔)
                <input
                  name="tags"
                  defaultValue={
                    editing === "new" ? "" : editing.tags.join(", ")
                  }
                  placeholder="report, weekly"
                  className="border-border-default bg-surface-2 text-fg rounded-control border px-3 py-2 text-caption"
                />
              </label>
            </div>

            <label className="text-fg-secondary text-label flex flex-col gap-1">
              正文(markdown;agent 加载后严格按里面的流程执行)
              <textarea
                name="body"
                defaultValue={editing === "new" ? "" : editing.body}
                required
                rows={10}
                placeholder={`# 周报生成\n\n## 步骤\n1. ...`}
                className="border-border-default bg-surface-2 text-fg mt-1 w-full resize-y rounded-control border p-3 font-mono text-caption"
              />
            </label>

            <div className="flex justify-end">
              <SubmitButton>保存技能</SubmitButton>
            </div>
          </form>
        )}

        {canManage && (
          <form action={importAction} className="flex flex-col gap-3">
            <label className="text-fg-secondary text-label">
              SKILL.md 内容
              <textarea
                name="markdown"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={`---\nname: weekly-report\ndescription: Use when generating a weekly report.\n---\n\n# 周报\n步骤...`}
                rows={8}
                required
                className="border-border-default bg-surface-3 text-fg text-caption mt-1 w-full resize-y rounded-control border p-3 font-mono"
              />
            </label>
            <input type="hidden" name="organizationId" value={organizationId} />

            {feedback && (
              <p
                className={
                  feedback.error
                    ? "text-error text-caption"
                    : "text-success text-caption"
                }
              >
                {feedback.error ?? feedback.ok}
              </p>
            )}

            <div className="flex justify-end">
              <SubmitButton>导入技能</SubmitButton>
            </div>
          </form>
        )}

        {!canManage && (
          <p className="text-fg-tertiary text-caption">
            组织成员都可以创建与编辑技能;技能归属于组织,而非个人。
          </p>
        )}
      </section>
    </div>
  );
}
