"use client";

import { useActionState, useState } from "react";

import { StatusLabel } from "@/components/primitives/StatusLabel";
import { Button } from "@/components/primitives/Button";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import { Input } from "@/components/primitives/Input";
import { Switch } from "@/components/primitives/Switch";
import {
  createMcpServer,
  deleteMcpServer,
  testMcpServer,
  toggleMcpServer,
  type McpServerState,
} from "@/app/(app)/settings/integrations/mcp-servers-actions";

/**
 * 外部 MCP server 管理。
 *
 * 这是产品独立于 Hermes 的界面入口:登记外部 MCP server 后,
 * 智能体的工具循环会自动注入 mcp__<server>__<tool> 工具。
 *
 * 三条界面纪律(与 McpTokens 同构):
 *   1. 令牌明文只出现一次,当场输入,不展示、不可回显
 *   2. 测试连接是**真的去调一次**,不是假装成功 —— 状态必须如实
 *   3. 启停/删除一眼可达;停用保留配置,删除连密文一起清掉
 */

export interface McpServerRow {
  id: string;
  name: string;
  url: string;
  credentialMasked: string;
  enabled: boolean;
  timeoutMs: number;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

function TestStatus({ row }: { row: McpServerRow }) {
  if (row.lastTestedAt === null) return <StatusLabel>未测试</StatusLabel>;
  if (row.lastTestOk) return <StatusLabel tone="success">连接正常</StatusLabel>;
  return <StatusLabel tone="error">连接失败</StatusLabel>;
}

export function McpServersCard({
  organizationId,
  servers,
  canManage,
}: {
  organizationId: string;
  servers: readonly McpServerRow[];
  canManage: boolean;
}) {
  const [createState, createAction] = useActionState<McpServerState, FormData>(
    createMcpServer,
    {},
  );
  const [testState, testAction] = useActionState<McpServerState, FormData>(
    testMcpServer,
    {},
  );
  const [toggleState, toggleAction] = useActionState<McpServerState, FormData>(
    toggleMcpServer,
    {},
  );
  const [deleteState, deleteAction] = useActionState<McpServerState, FormData>(
    deleteMcpServer,
    {},
  );

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("15");

  const enabledCount = servers.filter((s) => s.enabled).length;
  const feedback = createState.error
    ? createState
    : testState.error
      ? testState
      : toggleState.error
        ? toggleState
        : deleteState.error
          ? deleteState
          : createState.ok
            ? createState
            : testState.ok
              ? testState
              : toggleState.ok
                ? toggleState
                : deleteState.ok
                  ? deleteState
                  : null;

  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-body font-medium">MCP Servers</h3>
        {servers.length > 0 ? (
          <StatusLabel tone="success">{`${enabledCount}/${servers.length} 启用`}</StatusLabel>
        ) : (
          <StatusLabel>未配置</StatusLabel>
        )}
      </div>

      <p className="text-fg-secondary text-caption mb-4">
        登记外部 MCP server,智能体就能调用它们的工具(mcp__server__tool)。
        与「MCP 接入」的方向相反:那是让外部客户端连进来,这是让智能体连出去。
      </p>

      {/* 列表 */}
      {servers.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {servers.map((s) => (
            <li
              key={s.id}
              className="border-border-default bg-surface-3 rounded-control flex flex-wrap items-center gap-3 p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-fg text-label font-medium font-mono">
                    {s.name}
                  </span>
                  <TestStatus row={s} />
                  {!s.enabled && <StatusLabel>已停用</StatusLabel>}
                </div>
                <p className="text-fg-tertiary text-label mt-0.5 break-all">
                  {s.url} · {s.credentialMasked} · 超时 {s.timeoutMs / 1000}s
                </p>
                {s.lastTestError && (
                  <p className="text-error text-label mt-1 break-all">
                    {s.lastTestError}
                  </p>
                )}
              </div>

              {canManage && (
                <div className="flex items-center gap-2">
                  <form action={testAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <input
                      type="hidden"
                      name="organizationId"
                      value={organizationId}
                    />
                    <Button type="submit" variant="secondary" size="sm">
                      测试连接
                    </Button>
                  </form>

                  <form
                    action={toggleAction}
                    className="flex items-center"
                    aria-label={`${s.enabled ? "停用" : "启用"} ${s.name}`}
                  >
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

      {/* 新增表单 */}
      {canManage && (
        <form action={createAction} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Input
              name="name"
              label="名字(工具前缀)"
              placeholder="github"
              value={name}
              onChange={setName}
              required
            />
            <Input
              name="timeoutMs"
              label="超时(秒)"
              type="number"
              min={1}
              max={60}
              value={timeoutMs}
              onChange={setTimeoutMs}
              required
            />
          </div>
          <Input
            name="url"
            label="Server 地址"
            placeholder="https://mcp.example.com"
            type="url"
            value={url}
            onChange={setUrl}
            required
          />
          <Input
            name="authToken"
            label="访问令牌(Bearer)"
            placeholder="仅本次输入,加密存储,不显示明文"
            type="password"
            value={authToken}
            onChange={setAuthToken}
            required
          />
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
            <SubmitButton>登记 server</SubmitButton>
          </div>
        </form>
      )}

      {!canManage && (
        <p className="text-fg-tertiary text-caption">
          只有组织的所有者或管理员可以管理 MCP Servers。
        </p>
      )}
    </section>
  );
}
