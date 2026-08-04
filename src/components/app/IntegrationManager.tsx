"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { StatusLabel } from "@/components/primitives/StatusLabel";
import { Button } from "@/components/primitives/Button";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import { Input } from "@/components/primitives/Input";
import {
  addIntegration,
  deleteIntegration,
  testIntegration,
  type IntegrationActionState,
} from "@/app/(app)/settings/integrations/actions";
import { INTEGRATIONS, getIntegrationSpec } from "@/lib/integrations/registry";

export interface IntegrationRow {
  id: string;
  kind: string;
  displayName: string;
  credentialMasked: string;
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

// 状态用圆点 + 文字。Badge 的圆角+边框+底色会被当成按钮 ——
// 集成页那张 Git 卡片上已经因此被反复点击。见 StatusLabel 里的说明。
function TestStatus({ row }: { row: IntegrationRow }) {
  if (row.lastTestedAt === null) return <StatusLabel>未测试</StatusLabel>;
  if (row.lastTestOk)
    return <StatusLabel tone="success">连接正常</StatusLabel>;
  return <StatusLabel tone="error">连接失败</StatusLabel>;
}

export function IntegrationManager({
  organizationId,
  integrations,
  canManage,
  encryptionAvailable,
}: {
  organizationId: string;
  integrations: readonly IntegrationRow[];
  canManage: boolean;
  encryptionAvailable: boolean;
}) {
  const [addState, addAction, adding] = useActionState<
    IntegrationActionState,
    FormData
  >(addIntegration, {});
  const [testState, testAction] = useActionState<
    IntegrationActionState,
    FormData
  >(testIntegration, {});
  const [deleteState, deleteAction] = useActionState<
    IntegrationActionState,
    FormData
  >(deleteIntegration, {});

  const [kind, setKind] = useState(INTEGRATIONS[0]?.kind ?? "tavily");
  const spec = getIntegrationSpec(kind);

  const feedback = addState.error
    ? addState
    : testState.error
      ? testState
      : deleteState.error
        ? deleteState
        : addState.ok
          ? addState
          : testState.ok
            ? testState
            : deleteState;

  return (
    <div className="flex flex-col gap-4">
      {!encryptionAvailable && (
        <div className="border-error-tint bg-error-tint rounded-control p-4">
          <p className="text-error font-zh text-caption">
            密钥加密不可用,当前无法配置集成。
          </p>
        </div>
      )}

      <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
        <h3 className="text-fg text-body mb-3 font-medium">已配置的集成</h3>

        {integrations.length === 0 ? (
          <p className="text-fg-tertiary text-caption">
            还没有配置任何集成。智能体目前只能依据自身知识和你提供的项目文件作答,
            无法获取实时信息。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {integrations.map((row) => (
              <li
                key={row.id}
                className="border-border-default rounded-control flex flex-col gap-2 border p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-fg flex items-center gap-2 text-[14px]">
                    <Icon name="link" size={15} className="text-brand shrink-0" />
                    {row.displayName}
                  </span>
                  <TestStatus row={row} />
                </div>

                <p className="text-fg-tertiary text-label font-mono break-all">
                  {row.credentialMasked}
                </p>

                {getIntegrationSpec(row.kind) && (
                  <p className="text-fg-secondary text-label">
                    {getIntegrationSpec(row.kind)!.capability}
                  </p>
                )}

                {row.lastTestOk === false && row.lastTestError && (
                  <p className="text-error text-label">{row.lastTestError}</p>
                )}

                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <form action={testAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <SubmitButton
                        variant="secondary"
                        size="sm"
                        pendingText="测试中…"
                      >
                        测试连接
                      </SubmitButton>
                    </form>
                    <form action={deleteAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <SubmitButton variant="ghost" size="sm" pendingText="删除中…">
                        删除
                      </SubmitButton>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && encryptionAvailable && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
          <h3 className="text-fg text-body mb-1 font-medium">添加集成</h3>
          <p className="text-fg-secondary text-caption mb-4">
            密钥提交后立即加密存储,数据库中不保存明文,界面只显示掩码。
          </p>

          <form action={addAction} className="flex flex-col gap-3">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="kind" value={kind} />

            <div className="flex flex-wrap gap-1.5">
              {INTEGRATIONS.map((i) => (
                <button
                  key={i.kind}
                  type="button"
                  onClick={() => setKind(i.kind)}
                  className={
                    "rounded-tag cursor-pointer border px-2.5 py-1 text-[12px] transition-colors duration-[var(--duration-hover)] ease-standard " +
                    (kind === i.kind
                      ? "border-brand bg-brand-tint text-brand"
                      : "border-border-default text-fg-tertiary hover:text-fg-secondary")
                  }
                >
                  {i.label}
                </button>
              ))}
            </div>

            {spec && (
              <p className="text-fg-tertiary text-label">
                {spec.capability}。
                <a
                  href={spec.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-brand hover:text-brand-hover ml-1"
                >
                  申请密钥与查看文档
                </a>
              </p>
            )}

            <Input
              name="credential"
              label="API 密钥"
              description={
                spec
                  ? `在服务商控制台生成的密钥(${spec.credentialHint})。`
                  : undefined
              }
              type="password"
              placeholder="粘贴密钥"
              required
              autoComplete="off"
            />

            <Button type="submit" loading={adding} className="self-start">
              保存
            </Button>
          </form>
        </section>
      )}

      {(feedback.error || feedback.ok) && (
        <div
          role="status"
          className={
            "rounded-control font-zh border p-3.5 " +
            (feedback.error
              ? "border-error-tint bg-error-tint"
              : "border-success-tint bg-success-tint")
          }
        >
          <p
            className={
              "text-caption whitespace-pre-line " +
              (feedback.error ? "text-error" : "text-success")
            }
          >
            {feedback.error ?? feedback.ok}
          </p>
          {feedback.hint && (
            <p className="text-fg-tertiary text-label mt-1">{feedback.hint}</p>
          )}
        </div>
      )}
    </div>
  );
}
