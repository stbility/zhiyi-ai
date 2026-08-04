"use client";

import { useActionState } from "react";

import { StatusLabel } from "@/components/primitives/StatusLabel";
import { Icon } from "@/components/icons/Icon";
import { Input } from "@/components/primitives/Input";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import {
  createMcpToken,
  revokeMcpToken,
  type McpTokenState,
} from "@/app/(app)/settings/integrations/mcp-actions";

/**
 * MCP 令牌管理。
 *
 * MCP 是把「工作流资产」交出去的接口:拿到令牌的客户端能读写这个组织的
 * 整个工作区。所以界面上有三件事不能省 ——
 *   1. 令牌明文只出现一次,必须当场说清楚
 *   2. 已有令牌只显示前缀,不能假装还能取回(库里只有哈希)
 *   3. 撤销要一眼可达,而且撤销后仍然列出来,保留审计痕迹
 */

export interface McpTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function McpTokens({
  organizationId,
  tokens,
  canManage,
  endpoint,
}: {
  organizationId: string;
  tokens: readonly McpTokenRow[];
  canManage: boolean;
  /** 完整的 MCP 端点地址,直接给用户复制进客户端配置 */
  endpoint: string;
}) {
  const [createState, createAction] = useActionState<McpTokenState, FormData>(
    createMcpToken,
    {},
  );
  const [revokeState, revokeAction] = useActionState<McpTokenState, FormData>(
    revokeMcpToken,
    {},
  );

  const active = tokens.filter((t) => t.revokedAt === null);

  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-body font-medium">MCP 接入</h3>
        {active.length > 0 ? (
          <StatusLabel tone="success">{`${active.length} 把有效令牌`}</StatusLabel>
        ) : (
          <StatusLabel>未开通</StatusLabel>
        )}
      </div>

      <p className="text-fg-secondary text-caption mb-4">
        让 OpenClaw、Hermes Agent 等支持 MCP 的客户端接入这个组织的工作区。
        它们用你自己的模型密钥跑,产出直接写回这里。
      </p>

      <div className="border-border-default bg-surface-3 rounded-control mb-4 p-3">
        <p className="text-fg-tertiary text-label mb-1">端点地址</p>
        <code className="text-fg-secondary text-label font-mono break-all">
          {endpoint}
        </code>
        <p className="text-fg-tertiary text-label mt-2">
          在客户端里配置为 HTTP 类型的 MCP server,把令牌放进 Authorization
          头(Bearer)。本端点不提供 SSE —— 无服务器函数维持不了长连接。
        </p>
      </div>

      {/* 直接给能照抄的配置,而不是一句「配置为 HTTP 类型的 MCP server」。
          后者要求用户自己去查 Hermes 的配置文件在哪、字段叫什么 ——
          而那正是接入最容易卡住的一步,也是我们完全知道答案的一步。

          格式取自官方文档:
          hermes-agent.nousresearch.com/docs/user-guide/features/mcp
          Hermes 读 ~/.hermes/config.yaml 的 mcp_servers,远程服务器用
          url + headers,是 YAML 不是 JSON。 */}
      <details className="border-border-default rounded-control mb-4 border p-3">
        <summary className="text-fg-secondary text-caption cursor-pointer">
          Hermes Agent 怎么接(照抄即可)
        </summary>
        <p className="text-fg-tertiary text-label mt-2">
          写进 <code className="font-mono">~/.hermes/config.yaml</code>,把
          <code className="font-mono"> 令牌 </code>换成上面签出来的那一串:
        </p>
        <pre className="bg-surface-3 rounded-control text-fg-secondary text-label mt-2 overflow-x-auto p-3 font-mono">
          {`mcp_servers:
  zhiyi:
    url: "${endpoint}"
    headers:
      Authorization: "Bearer 令牌"`}
        </pre>
        <p className="text-fg-tertiary text-label mt-2">
          接上后先让它调 <code className="font-mono">zhiyi_whoami</code>{" "}
          验证连通性。工作区四件套一直可用;
          <strong className="text-fg-secondary">
            读写仓库、提 PR 的那三个工具,只有本组织连了 GitHub 之后才会出现在
            清单里
          </strong>
          —— 没连就不列,免得它反复去试一个注定失败的调用。
        </p>
      </details>

      {/* 令牌明文只出现这一次。库里存的是 sha256,我们自己也还原不回来 */}
      {createState.token && (
        <div className="border-brand bg-brand-tint rounded-control mb-4 border p-3">
          <p className="text-brand text-label mb-1.5 font-medium">
            这是唯一一次能看到完整令牌 —— 现在就复制保存
          </p>
          <code className="text-fg text-label font-mono break-all select-all">
            {createState.token}
          </code>
          <p className="text-fg-tertiary text-label mt-2">
            关掉或刷新之后无法再取回。丢了就撤销这把、重新签一把。
          </p>
        </div>
      )}

      {createState.error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control text-caption mb-3 p-3">
          {createState.error}
        </p>
      )}
      {revokeState.error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control text-caption mb-3 p-3">
          {revokeState.error}
        </p>
      )}
      {revokeState.ok && (
        <p className="border-success bg-success-tint text-success rounded-control text-caption mb-3 p-3">
          {revokeState.ok}
        </p>
      )}

      {canManage && (
        <form action={createAction} className="mb-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="organizationId" value={organizationId} />
          <label className="min-w-0 flex-1">
            <span className="text-fg-tertiary text-label mb-1 block">
              名字 —— 用来分辨这把是给谁的
            </span>
            <Input name="name" placeholder="例如:OpenClaw 生产" required />
          </label>
          <SubmitButton size="sm">签发令牌</SubmitButton>
        </form>
      )}

      {tokens.length === 0 ? (
        <p className="text-fg-tertiary text-label">还没有签发过令牌。</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-start gap-2">
              <Icon
                name={t.revokedAt ? "x" : "check"}
                size={12}
                className={`mt-1 shrink-0 ${t.revokedAt ? "text-fg-tertiary" : "text-success"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="text-fg-secondary text-label">{t.name}</span>
                <span className="text-fg-tertiary text-label ml-2 font-mono">
                  {t.tokenPrefix}…
                </span>
                <span className="text-fg-tertiary text-label block">
                  {t.revokedAt
                    ? "已撤销"
                    : t.lastUsedAt
                      ? `最近使用:${new Date(t.lastUsedAt).toLocaleString("zh-CN")}`
                      : "尚未使用过"}
                </span>
              </span>
              {canManage && t.revokedAt === null && (
                <form action={revokeAction}>
                  <input type="hidden" name="id" value={t.id} />
                  <SubmitButton size="sm" variant="secondary">
                    撤销
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
