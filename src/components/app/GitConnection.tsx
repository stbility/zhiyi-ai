import { Icon } from "@/components/icons/Icon";
import { StatusLabel } from "@/components/primitives/StatusLabel";
import { LinkButton } from "@/components/primitives/LinkButton";
import { GitDisconnect } from "@/components/app/GitDisconnect";
import { GitTestAccess } from "@/components/app/GitTestAccess";
import { GitManualConnect } from "@/components/app/GitManualConnect";

export interface GitConnectionProps {
  /** App 是否已在服务端配置。未配置时如实说明,不显示任何可点的连接入口 */
  configured: boolean;
  /** 已连接的安装。null 表示尚未连接 */
  installation: {
    accountLogin: string | null;
    installationId: string;
    connectedAt: string;
    /**
     * 拿这个安装编号真的问过 GitHub,并且问到了。
     *
     * 「库里有一行」不等于「连接可用」。生产上出现过一条
     * installation_id = "<151228033>" 的记录 —— 带尖括号,编码后是
     * %3C…%3E,调任何接口都必然 404;而卡片照样显示「已连接」,
     * 因为判断依据只是「查到了一行」。
     *
     * 用户一个文件都读不到,却没有任何办法看出区别。
     * 状态必须以**当下问得到的事实**为准,不是以库里存过什么为准。
     */
    verified: boolean;
    /** 安装编号本身的格式是否合法(纯数字)。不联网就能判 */
    formatValid: boolean;
    /** GitHub 当下回答的账号名。库里那份只是缓存,以这个为准 */
    liveAccountLogin: string | null;
    /**
     * 非空表示:应用**已在 GitHub 上装好**,但本站换取访问令牌失败,
     * 仓库工具暂时用不了。
     *
     * 这一栏存在的理由:此前换不到令牌就什么都不写,卡片一直显示
     * 「未连接」—— 而用户看着 GitHub 上明明装好了的应用,只能得出
     * 「这功能是坏的」。他没说错,但原因不是没装上。
     * 安装是 GitHub 侧的客观事实,凭据坏是我们这边的问题,两件事。
     */
    credentialError?: string | null | undefined;
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
  /**
   * 当前配置的私钥指纹,格式与 GitHub App 设置页「Private keys」里
   * 列出的完全一致(官方算法:公钥 DER 的 SHA-256,再 base64)。
   *
   * 这一条是用来**终结猜测**的。GitHub 对「私钥不属于这个 App」返回的
   * 原话是 `A JSON web token could not be decoded` —— 听起来像 JWT 拼错了,
   * 排查方向因此被带偏过好几轮。指纹能一眼比对:一样就是同一把,
   * 不一样就是拿错了,不必再换一次密钥重试一次。
   *
   * 指纹是**公开信息**(GitHub 自己就印在设置页上),私钥一个字节都不涉及。
   */
  keyFingerprint?: string | null | undefined;
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
  keyFingerprint,
  notice,
}: GitConnectionProps) {
  // 凭据没通过验证时的指纹对照。
  //
  // **两个分支都要显示**,这一点我第一版做错了:只放进了「拿不到安装
  // 地址」那一支。而 slug 现在能免鉴权从公开页查证 —— 私钥不对时照样
  // 拿得到地址,走的是另一支,于是这块诊断永远不渲染,等于没做。
  //
  // 判据是 slugError:它非空就说明 GET /app 没通过,而那一步用的正是
  // 私钥。此时指纹就是最直接的下一步。
  const 指纹对照 =
    slugError && keyFingerprint ? (
      <div className="border-border-default rounded-control border border-dashed p-3">
        <p className="text-fg-secondary text-caption">本站当前使用的私钥指纹</p>
        <code className="text-fg text-label mt-1 block font-mono break-all select-all">
          {keyFingerprint}
        </code>
        <p className="text-fg-tertiary text-label mt-2">
          到 GitHub App 设置页的「Private keys」区块比对。
          一致说明这把密钥属于该 App,问题在别处(多半是环境变量没进
          Production,或改完没重新部署);不一致就是拿错了 App 或拿错了密钥。
          换一把再试之前,先用这一行确认。
        </p>
      </div>
    ) : null;

  return (
    <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="text-fg text-body font-medium">Git 仓库</h3>
        {/* 状态用圆点 + 文字,不用 Badge。
            Badge 的圆角+边框+底色在这个位置会被当成按钮 —— 用户反复点它、
            反复来问「这个按钮坏了」。见 StatusLabel 里的说明。 */}
        {!configured ? (
          <StatusLabel>未配置</StatusLabel>
        ) : installation?.credentialError ? (
          // 装上了,但我们这边换不到令牌 —— 既不是「已连接」也不是「未连接」。
          // 之前只有两态,于是这种情况被显示成「未连接」,
          // 而用户看着 GitHub 上明明装好的应用,只能认为这功能是坏的。
          <StatusLabel tone="warning">已安装 · 凭据待修复</StatusLabel>
        ) : installation ? (
          // 验证不过时**不显示「已连接」**。这是这张卡片上最要紧的一条:
          // 说「已连接」而实际读不到任何文件,和放假数据是同一类问题。
          installation.verified ? (
            <StatusLabel tone="success">已连接</StatusLabel>
          ) : (
            <StatusLabel tone="warning">连接异常</StatusLabel>
          )
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
          {/* 装上了,但我们这边换不到令牌。
              把「安装是成的」和「凭据是坏的」分开说 —— 否则用户会反复
              重装,而重装多少次都一样,坏的根本不是安装。 */}
          {installation.credentialError && (
            <p className="border-warning bg-warning-tint text-warning rounded-control text-caption p-3 whitespace-pre-line">
              应用已经装在 GitHub 上了,这条记录不会丢,**也不需要重装** ——
              凭据修好后自动恢复。
              {"\n"}
              但本站换取访问令牌失败,所以仓库工具现在还用不了:
              {"\n"}
              {installation.credentialError}
            </p>
          )}
          <div className="text-fg-secondary text-caption flex flex-wrap items-center gap-2">
            <Icon
              name="link"
              size={14}
              className={
                installation.credentialError
                  ? "text-warning shrink-0"
                  : "text-success shrink-0"
              }
            />
            <span>
              {installation.verified
                ? "已连接到"
                : installation.credentialError
                  ? "已安装"
                  : "连接记录存在,但未能向 GitHub 验证 ——"}{" "}
              {installation.liveAccountLogin ??
                installation.accountLogin ??
                "GitHub 账号"}
              (安装编号{" "}
              <span className="font-mono">{installation.installationId}</span>)
            </span>
          </div>
          {/* 验证不过时把原因摆出来,并区分两种完全不同的成因。
              不区分的话,用户会去重装应用 —— 而如果坏的是编号本身,
              重装多少次都一样。 */}
          {!installation.verified && (
            <p className="border-warning bg-warning-tint text-warning rounded-control text-caption p-3">
              {!installation.formatValid
                ? "这条记录里的安装编号不是纯数字,不可能是 GitHub 发出来的" +
                  "(多半是手工写进数据库的)。仓库工具用不了。" +
                  "请点下面的「断开连接」清掉它,再走一次「连接 GitHub」。"
                : "安装编号格式正常,但向 GitHub 查询这个安装时没有取到账号信息 ——" +
                  "可能是应用已在 GitHub 侧被卸载,或本站凭据当前不可用。" +
                  "重新走一次「连接 GitHub」即可;仍然如此的话,问题在应用凭据。"}
            </p>
          )}

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
              {/* 验证通过之后才给测试入口。没通过时链路的前一段就是断的,
                  再点一次只会得到同一个错误,徒增一轮困惑。 */}
              {installation.verified && <GitTestAccess />}
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
            {指纹对照}
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
            {指纹对照}
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
