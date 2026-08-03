import { Badge } from "@/components/primitives/Badge";
import { Icon } from "@/components/icons/Icon";
import { buttonClasses } from "@/components/primitives/Button";

export interface GitConnectionProps {
  /** App 是否已在服务端配置。未配置时如实说明,不显示任何可点的连接入口 */
  configured: boolean;
  /** 已连接的安装。null 表示尚未连接 */
  installation: {
    accountLogin: string | null;
    installationId: string;
    connectedAt: string;
  } | null;
  /** 去 GitHub 授权的地址。未配置时为 null */
  installHref: string | null;
  canManage: boolean;
  /** 回调带回来的提示 */
  notice?: { ok?: boolean; error?: string } | undefined;
}

/**
 * Git 仓库连接卡片。
 *
 * 走 GitHub App 而不是 Personal Access Token:
 *   · 权限按仓库授予 —— 用户在 GitHub 上勾哪些,我们就只能碰哪些
 *   · 凭据是短期的(安装令牌活 1 小时),我们从不持有用户的长期令牌
 *   · 用户随时能在 GitHub 侧一键撤销,不必回来这里删
 *
 * 未配置时**不显示可点的按钮**。给一个点了必然失败的入口,
 * 和放一个空按钮是同一类问题。
 */
export function GitConnection({
  configured,
  installation,
  installHref,
  canManage,
  notice,
}: GitConnectionProps) {
  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-body font-medium">Git 仓库</h3>
        {!configured ? (
          <Badge>未配置</Badge>
        ) : installation ? (
          <Badge tone="success">已连接</Badge>
        ) : (
          <Badge>未连接</Badge>
        )}
      </div>

      <p className="text-fg-secondary text-caption mb-4">
        连接后,智能体可以直接读写你授权的仓库,而不必把代码复制进对话。
        权限由你在 GitHub 上按仓库勾选,随时可在 GitHub 侧撤销。
      </p>

      {notice?.error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control text-caption mb-3 p-3">
          {notice.error}
        </p>
      )}
      {notice?.ok && (
        <p className="border-success bg-success-tint text-success rounded-control text-caption mb-3 p-3">
          已连接成功。
        </p>
      )}

      {!configured ? (
        // 如实说明缺什么。这不是「即将推出」,是部署侧还没配 ——
        // 两者对用户的意义完全不同
        <div className="border-border-default rounded-control text-fg-tertiary text-caption border border-dashed p-4">
          服务端尚未配置 GitHub App,该功能暂不可用。
          <span className="mt-1 block">
            需要配置 GITHUB_APP_CLIENT_ID、GITHUB_APP_PRIVATE_KEY、GITHUB_APP_SLUG
            三个环境变量。
          </span>
        </div>
      ) : installation ? (
        <div className="flex flex-col gap-3">
          <div className="text-fg-secondary text-caption flex flex-wrap items-center gap-2">
            <Icon name="link" size={14} className="text-success shrink-0" />
            <span>
              已连接到 {installation.accountLogin ?? "GitHub 账号"}(安装编号{" "}
              <span className="font-mono">{installation.installationId}</span>)
            </span>
          </div>
          {canManage && installHref && (
            <a
              href={installHref}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              <Icon name="settings" size={14} />
              调整授权的仓库
            </a>
          )}
        </div>
      ) : canManage ? (
        installHref ? (
          <a href={installHref} className={buttonClasses({ size: "sm" })}>
            <Icon name="link" size={14} />
            连接 GitHub
          </a>
        ) : (
          // 拼不出安装地址时不给可点的按钮。
          // 此前这里是 href={installHref ?? "#"} —— 取不到地址仍然渲染一个
          // 看起来能点的按钮,点下去要么原地不动,要么跳到 404。
          <p className="text-fg-tertiary text-caption">
            暂时取不到应用的安装地址(向 GitHub 查询失败),请稍后重试。
          </p>
        )
      ) : (
        <p className="text-fg-tertiary text-caption">
          需要组织管理员才能连接仓库。
        </p>
      )}
    </section>
  );
}
