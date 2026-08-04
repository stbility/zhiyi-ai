import { Icon } from "@/components/icons/Icon";
import { StatusLabel } from "@/components/primitives/StatusLabel";
import { LinkButton } from "@/components/primitives/LinkButton";
import { GitDisconnect } from "@/components/app/GitDisconnect";
import { GitManualConnect } from "@/components/app/GitManualConnect";

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
  /**
   * 取安装地址失败的原因,来自 getAppSlug()。
   *
   * 这个 prop 此前**不存在** —— 上面那行注释悬空挂在 notice 头上,
   * 我写了说明却没写字段。于是原因只进了服务端日志,而部署在 Vercel 上,
   * 用户看不到日志,卡片上只有一句「详情见服务端日志」——
   * 等于告诉他「原因存在,但你无权知道」。
   *
   * 内容里只有 GitHub 的原话和 Client ID(公开值,设置页上就印着),
   * 私钥一个字都不出现 —— 具体见 getAppSlug 里的构造。
   */
  slugError?: string | null | undefined;
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
  slugError,
  notice,
}: GitConnectionProps) {
  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-body font-medium">Git 仓库</h3>
        {/* 状态用圆点 + 文字,不用 Badge。
            Badge 的圆角+边框+底色在这个位置会被当成按钮 —— 用户反复点它、
            反复来问「这个按钮坏了」。见 StatusLabel 里的说明。 */}
        {!configured ? (
          <StatusLabel>未配置</StatusLabel>
        ) : installation ? (
          <StatusLabel tone="success">已连接</StatusLabel>
        ) : (
          <StatusLabel>未连接</StatusLabel>
        )}
      </div>

      <p className="text-fg-secondary text-caption mb-4">
        连接后,智能体可以直接读写你授权的仓库,而不必把代码复制进对话。
        权限由你在 GitHub 上按仓库勾选,随时可在 GitHub 侧撤销。
      </p>

      {/* 这一轮连接的结果,紧挨着**它对应的那个动作**放。
          此前它浮在卡片最上面、紧跟标题 —— 读起来像整页出了错,
          而它其实只是「刚才那次连接的回执」。
          位置本身就是信息:贴着按钮,才看得出它在说哪件事。 */}
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
          {/* 已连接状态下两个动作都要有:改仓库范围、断开。
              对齐 ChatGPT / Codex 的 GitHub 连接器 ——
              Choose repositories 与 Disconnect 是并列的两项。
              来源:help.openai.com/en/articles/11145903-connecting-github-to-chatgpt
              此前只有前者,连上之后就没有退路。 */}
          {canManage && (
            <div className="flex flex-col gap-2">
              {installHref && (
                <LinkButton
                  href={installHref}
                  variant="secondary"
                  size="sm"
                  className="self-start"
                >
                  <Icon name="settings" size={14} />
                  调整授权的仓库
                </LinkButton>
              )}
              <GitDisconnect
                installationId={installation.installationId}
                accountLogin={installation.accountLogin}
              />
            </div>
          )}
        </div>
      ) : canManage ? (
        installHref ? (
          <div className="flex flex-col gap-3">
            {/* 有安装地址**不等于**这条路走得通。
                slug 有两个来源:GET /app(权威,要私钥认证)和公开页查证
                (免鉴权)。私钥不对时会走第二条 —— slug 照样拿得到、
                按钮照样出现,而认证其实是坏的。

                此前这里什么都不显示,于是用户点进去、在 GitHub 上装完、
                跳回来才发现失败,而且看不出为什么。**把人送进一条
                注定走不通的路,却不在入口提醒,是最糟的一种设计。**

                slugError 非空就说明 GET /app 没通过(getAppSlug 只在
                回退到公开页查证时才带着 error 返回 slug)。 */}
            {slugError && (
              <p className="border-warning bg-warning-tint text-warning rounded-control text-caption p-3 whitespace-pre-line">
                安装地址可用,但**应用凭据没通过验证** ——
                你可以点下面的按钮去 GitHub 完成安装,但装完跳回来时
                本站换取访问令牌会失败,状态不会变成「已连接」。
                {"\n"}
                {slugError}
              </p>
            )}
            <LinkButton href={installHref} size="sm" className="self-start">
              <Icon name="link" size={14} />
              连接 GitHub
            </LinkButton>
          </div>
        ) : (
          // 自动拿不到安装地址时,给手动入口 —— 不给假按钮,但也不能让
          // 整张卡片变成死页面。
          //
          // 这里曾经只有一句「暂时无法连接,详情见服务端日志」,
          // 卡片上一个可交互元素都没有。而「未连接」那个状态标签是圆角、
          // 带边框、有底色的小块,在一张写着"未连接"的卡片上看起来就是
          // 该点的地方 —— 用户去点它是必然的,不是误解。
          //
          // 官方的安装地址只需要应用名,而用户自己知道那个名字。
          <div className="flex flex-col gap-3">
            {slugError ? (
              // 把真实原因摆在用户面前。
              // 「详情见服务端日志」对 Vercel 上的部署等于没说 —— 日志在
              // 另一个平台的后台里,而看这张卡片的人往往正是配环境变量的人,
              // 原因给到他手上,他一眼就知道该改哪个变量。
              <p className="border-border-default rounded-control text-fg-secondary text-caption border border-dashed p-3 whitespace-pre-line">
                {slugError}
              </p>
            ) : (
              <p className="text-fg-tertiary text-caption">
                未能自动获取安装地址。
              </p>
            )}
            <GitManualConnect />
          </div>
        )
      ) : (
        <p className="text-fg-tertiary text-caption">
          需要组织管理员才能连接仓库。
        </p>
      )}
    </section>
  );
}
