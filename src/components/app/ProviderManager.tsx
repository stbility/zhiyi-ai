"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Select } from "@/components/primitives/Select";
import {
  addProvider,
  deleteProvider,
  testProvider,
  type ProviderActionState,
} from "@/app/(app)/settings/models/actions";
import {
  COMPATIBLE_PRESETS,
  PROVIDERS,
  getProviderSpec,
  type ProviderKind,
} from "@/lib/providers/registry";

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string | null;
  apiKeyMasked: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

function TestStatus({ row }: { row: ProviderRow }) {
  if (row.lastTestedAt === null) {
    return <Badge>未测试</Badge>;
  }
  if (row.lastTestOk) {
    return <Badge tone="success">连接正常</Badge>;
  }
  return <Badge tone="error">连接失败</Badge>;
}

export function ProviderManager({
  organizationId,
  providers,
  canManage,
  encryptionAvailable,
}: {
  organizationId: string;
  providers: readonly ProviderRow[];
  canManage: boolean;
  encryptionAvailable: boolean;
}) {
  const [addState, addAction, adding] = useActionState<
    ProviderActionState,
    FormData
  >(addProvider, {});
  const [testState, testAction] = useActionState<ProviderActionState, FormData>(
    testProvider,
    {},
  );
  const [deleteState, deleteAction] = useActionState<
    ProviderActionState,
    FormData
  >(deleteProvider, {});

  const [kind, setKind] = useState<ProviderKind>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const spec = getProviderSpec(kind);

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
            密钥加密不可用,当前无法添加模型服务。
          </p>
          <p className="text-fg-tertiary font-zh text-label mt-1">
            ENCRYPTION_KEY 未配置或格式不正确。系统绝不会以明文存储密钥。
          </p>
        </div>
      )}

      {/* 已配置的服务 */}
      <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
        <h3 className="text-fg text-body mb-3 font-medium">已配置的模型服务</h3>

        {providers.length === 0 ? (
          <p className="text-fg-tertiary text-caption">
            还没有配置任何模型服务。添加后 AI 能力才能使用。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {providers.map((row) => (
              <li
                key={row.id}
                className="border-border-default rounded-control flex flex-col gap-2 border p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-fg flex items-center gap-2 text-[14px]">
                    <Icon name="bot" size={15} className="text-brand shrink-0" />
                    {row.displayName}
                  </span>
                  <TestStatus row={row} />
                </div>

                <p className="text-fg-tertiary text-label font-mono break-all">
                  {getProviderSpec(row.kind).label} · {row.apiKeyMasked}
                  {row.baseUrl ? ` · ${row.baseUrl}` : ""}
                </p>

                {row.lastTestOk === false && row.lastTestError && (
                  <p className="text-error text-label">{row.lastTestError}</p>
                )}

                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <form action={testAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <Button type="submit" variant="secondary" size="sm">
                        测试连接
                      </Button>
                    </form>
                    <form action={deleteAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        删除
                      </Button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 添加 */}
      {canManage && encryptionAvailable && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
          <h3 className="text-fg text-body mb-1 font-medium">添加模型服务</h3>
          <p className="text-fg-secondary text-caption mb-4">
            密钥提交后立即加密存储,数据库中不保存明文,界面只显示掩码。
          </p>

          <form action={addAction} className="flex flex-col gap-3">
            <input type="hidden" name="organizationId" value={organizationId} />

            <div className="flex flex-col gap-1.5">
              <label className="font-zh text-label text-fg-secondary">
                服务商类型
              </label>
              <Select
                name="kind"
                value={kind}
                onChange={(v) => setKind(v as ProviderKind)}
                options={PROVIDERS.map((p) => ({
                  value: p.kind,
                  label: p.label,
                }))}
                className="w-full"
              />
              <p className="text-fg-tertiary text-label">{spec.description}</p>
            </div>

            <Input
              name="displayName"
              label="给这个连接起个名字"
              description="仅用于在列表中辨认,可随意填写,与服务商无关。"
              placeholder="例如:我的 DeepSeek"
              required
              maxLength={60}
            />

            <div className="flex flex-col gap-1.5">
              <Input
                name="baseUrl"
                label="接口地址(Base URL)"
                description={
                  spec.requiresBaseUrl
                    ? "服务商文档里的 API 地址。可点下方预设一键填入。"
                    : "留空则使用官方默认地址。"
                }
                placeholder={spec.defaultBaseUrl ?? "https://api.example.com/v1"}
                required={spec.requiresBaseUrl}
                value={baseUrl}
                onChange={setBaseUrl}
              />
              {spec.requiresBaseUrl ? (
                <div className="flex flex-wrap gap-1.5">
                  {COMPATIBLE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setBaseUrl(preset.baseUrl)}
                      className="border-border-default rounded-tag text-fg-tertiary hover:text-fg-secondary hover:border-border-strong cursor-pointer border px-2 py-1 text-[11px] transition-colors duration-[var(--duration-hover)] ease-standard"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <Input
              name="apiKey"
              label="API 密钥"
              description={`在服务商控制台生成的密钥(${spec.keyHint})。提交后立即加密,数据库不存明文。`}
              type="password"
              placeholder="粘贴密钥"
              required
              autoComplete="off"
            />

            <Button type="submit" loading={adding} className="w-full sm:w-auto">
              {adding ? "保存中…" : "添加"}
            </Button>
          </form>
        </section>
      )}

      {!canManage && (
        <p className="text-fg-tertiary font-zh text-caption">
          只有组织的所有者或管理员可以配置模型服务。
        </p>
      )}

      {(feedback.error || feedback.ok) && (
        <div
          role="status"
          className={
            feedback.error
              ? "border-error-tint bg-error-tint rounded-control p-3"
              : "border-success-tint bg-success-tint rounded-control p-3"
          }
        >
          <p
            className={
              feedback.error
                ? "text-error font-zh text-caption"
                : "text-success font-zh text-caption"
            }
          >
            {feedback.error ?? feedback.ok}
          </p>
          {feedback.hint && (
            <p className="text-fg-tertiary font-zh text-label mt-1">
              {feedback.hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
