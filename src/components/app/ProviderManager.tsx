"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Select } from "@/components/primitives/Select";
import { cn } from "@/lib/cn";
import {
  addProvider,
  deleteModel,
  restoreModel,
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

/** 预设的展示分组与顺序 */
const PRESET_GROUPS = ["国内", "国际", "聚合", "本地"] as const;

/** 某个服务商下的一个模型 */
export interface ModelRow {
  modelId: string;
  /** 非空表示不可用于对话,值为原因。系统不会自动写入 —— 只由用户决定 */
  unavailableReason: string | null;
  /** 上次调用失败的原因。仅作留痕,不影响该模型是否可选 */
  lastError: string | null;
}

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

/**
 * 该服务商下的模型清单。
 *
 * 不可用的也要列出来并写明原因。此前它们只是从助手页的下拉框里消失,
 * 用户在服务商控制台明明看得到 Kimi,系统里却无声无息 ——
 * 那只会让人怀疑是系统把模型弄丢了,根本无从排查。
 */
function ModelList({
  providerId,
  models,
  excluded,
  canManage,
}: {
  providerId: string;
  models: readonly ModelRow[];
  excluded: readonly string[];
  canManage: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [, removeAction] = useActionState<ProviderActionState, FormData>(
    deleteModel,
    {},
  );
  const [, restoreAction] = useActionState<ProviderActionState, FormData>(
    restoreModel,
    {},
  );

  const usable = models.filter((m) => m.unavailableReason === null);
  const blocked = models.filter((m) => m.unavailableReason !== null);

  const removeButton = (modelId: string) => (
    <form action={removeAction} className="shrink-0">
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="modelId" value={modelId} />
      <button
        type="submit"
        aria-label={`删除模型 ${modelId}`}
        title="从列表中删除"
        className="text-fg-tertiary hover:text-error cursor-pointer p-0.5 transition-colors duration-[var(--duration-hover)] ease-standard"
      >
        <Icon name="x" size={12} />
      </button>
    </form>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-fg-tertiary text-label flex flex-wrap items-center gap-2">
        <span>
          模型 {usable.length} 个可用
          {blocked.length > 0 ? `,${blocked.length} 个不可用` : ""}
          {excluded.length > 0 ? `,${excluded.length} 个已删除` : ""}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-brand hover:text-brand-hover cursor-pointer"
        >
          {expanded ? "收起" : "查看明细"}
        </button>
      </div>

      {expanded && (
        <>
          <ul className="flex flex-col gap-1">
            {usable.map((m) => (
              <li key={m.modelId} className="flex items-start gap-1.5">
                <Icon
                  name={m.lastError ? "alert" : "check"}
                  size={12}
                  className={cn(
                    "mt-1 shrink-0",
                    m.lastError ? "text-warning" : "text-success",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-fg-secondary text-label font-mono break-all">
                    {m.modelId}
                  </span>
                  {/* 上次失败只是留痕,模型仍然可选 —— 说清楚这一点,
                      否则用户会以为它又被系统禁用了 */}
                  {m.lastError && (
                    <span className="text-fg-tertiary text-label block">
                      上次调用失败(仍可选用):{m.lastError}
                    </span>
                  )}
                </span>
                {canManage && removeButton(m.modelId)}
              </li>
            ))}
            {blocked.map((m) => (
              <li key={m.modelId} className="flex items-start gap-1.5">
                <Icon name="x" size={12} className="text-error mt-1 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="text-fg-tertiary text-label font-mono break-all">
                    {m.modelId}
                  </span>
                  <span className="text-fg-tertiary text-label block">
                    {m.unavailableReason}
                  </span>
                </span>
                {canManage && removeButton(m.modelId)}
              </li>
            ))}
          </ul>

          {/* 已删除的单独一组:删除是决定,不是永久黑名单 ——
              随时看得到、随时能改主意,才不会出现「删了又莫名回来」。
              每个模型各自一条记录,互不牵连。 */}
          {excluded.length > 0 && (
            <div className="border-divider flex flex-col gap-1 border-t pt-2">
              <p className="text-fg-tertiary text-label">
                已删除(测试连接不会重新导入)
              </p>
              {excluded.map((modelId) => (
                <div key={modelId} className="flex items-center gap-1.5">
                  <span className="text-fg-tertiary text-label min-w-0 flex-1 font-mono break-all line-through">
                    {modelId}
                  </span>
                  {canManage && (
                    <form action={restoreAction} className="shrink-0">
                      <input type="hidden" name="providerId" value={providerId} />
                      <input type="hidden" name="modelId" value={modelId} />
                      <button
                        type="submit"
                        className="text-brand hover:text-brand-hover text-label cursor-pointer"
                      >
                        恢复
                      </button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ProviderManager({
  organizationId,
  providers,
  modelsByProvider,
  exclusionsByProvider,
  canManage,
  encryptionAvailable,
}: {
  organizationId: string;
  providers: readonly ProviderRow[];
  modelsByProvider: Record<string, ModelRow[]>;
  exclusionsByProvider: Record<string, string[]>;
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

                <ModelList
                  providerId={row.id}
                  models={modelsByProvider[row.id] ?? []}
                  excluded={exclusionsByProvider[row.id] ?? []}
                  canManage={canManage}
                />

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
                <div className="flex flex-col gap-2.5">
                  <p className="text-fg-tertiary font-zh text-label">
                    点击一键填入。预设只是省去查文档,不是白名单 ——
                    任何 OpenAI 兼容地址都能手填,包括自建服务与未列出的服务商。
                  </p>
                  {PRESET_GROUPS.map((group) => (
                    <div key={group} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-fg-tertiary font-zh text-label w-9 shrink-0">
                        {group}
                      </span>
                      {COMPATIBLE_PRESETS.filter((p) => p.group === group).map(
                        (preset) => (
                          <span
                            key={preset.label}
                            className="border-border-default rounded-tag inline-flex items-center overflow-hidden border"
                          >
                            <button
                              type="button"
                              onClick={() => setBaseUrl(preset.baseUrl)}
                              title={preset.baseUrl}
                              className="text-fg-tertiary hover:text-fg-secondary cursor-pointer px-2 py-1 text-[11px] transition-colors duration-[var(--duration-hover)] ease-standard"
                            >
                              {preset.label}
                            </button>
                            {/* 直达官方文档 —— 地址会变,密钥也在那里申请 */}
                            <a
                              href={preset.docsUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={`${preset.label} 官方 API 文档`}
                              aria-label={`${preset.label} 官方 API 文档`}
                              className="border-border-default text-fg-tertiary hover:text-brand border-l px-1.5 py-1 transition-colors duration-[var(--duration-hover)] ease-standard"
                            >
                              <Icon name="externalLink" size={11} />
                            </a>
                          </span>
                        ),
                      )}
                    </div>
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
