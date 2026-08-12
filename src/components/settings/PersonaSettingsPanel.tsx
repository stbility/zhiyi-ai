"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/primitives/Button";
import { TextArea } from "@/components/primitives/TextArea";
import { cn } from "@/lib/cn";
import {
  savePersona,
  type PersonaActionState,
} from "@/app/(app)/settings/persona/actions";

/**
 * 品牌人格设置面板(P3,2026-08-11)。
 *
 * 组织级自定义人格,注入智能体系统提示词。textarea 用原生元素 +
 * 设计系统 token 类名(仓库没有 TextArea primitive,Input 是单行,
 * 人格配置需要多行编辑)。
 *
 * 保存走 savePersona(server action):写 organizations.persona,
 * RLS 保证只有 owner/admin 能改。
 */
export function PersonaSettingsPanel({
  organizationId,
  initialPersona,
}: {
  organizationId: string;
  initialPersona: string;
}) {
  const [persona, setPersona] = useState(initialPersona);
  const [state, action] = useActionState<PersonaActionState, FormData>(
    savePersona,
    { ok: true, message: "" },
  );

  const dirty = persona !== initialPersona;

  return (
    <section className="border-border-default bg-surface-2 flex flex-col gap-4 rounded-panel border p-6">
      <div>
        <h2 className="text-fg text-h3 font-zh font-semibold">品牌人格</h2>
        <p className="text-fg-secondary font-zh text-caption mt-1">
          组织级自定义人格:语气、品牌名、专属指令。配置后注入智能体系统提示词,
          所有成员的新智能体运行都会遵循。留空使用默认人格。
        </p>
      </div>

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />

        <label className="flex flex-col gap-1.5">
          <span className="text-fg font-zh text-label">人格指令</span>
          <TextArea
            name="persona"
            value={persona}
            onChange={setPersona}
            rows={8}
            maxLength={2000}
            placeholder={
              "例如:\n你是「某某科技」的品牌助手。\n回答保持简洁专业,使用繁体中文。\n涉及公司数据时一律引用知识库,不要凭记忆作答。"
            }
          />
          <span className="text-fg-tertiary font-zh text-caption">
            {persona.length}/2000 字
          </span>
        </label>

        {state.message && (
          <p
            className={cn(
              "font-zh text-caption",
              state.ok ? "text-success" : "text-danger",
            )}
          >
            {state.message}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!dirty}
          >
            保存
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => setPersona(initialPersona)}
            >
              撤销
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
