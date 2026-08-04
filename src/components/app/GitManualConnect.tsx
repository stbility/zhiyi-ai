"use client";

import { useActionState } from "react";

import { Icon } from "@/components/icons/Icon";
import { Input } from "@/components/primitives/Input";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import {
  connectViaSlug,
  type ConnectState,
} from "@/app/(app)/settings/integrations/git-actions";

/**
 * 自动拿不到安装地址时的手动入口。
 *
 * 这里存在的理由,是一次真实的设计疏漏:
 *
 * 自动查证失败时,卡片上只剩一句「暂时无法连接,详情见服务端日志」——
 * 整张卡片**没有一个可交互元素**。而「未连接」那个状态标签是圆角、
 * 带边框、有底色的小块,在一张写着"未连接"的卡片上,看起来就是该点的地方。
 * 页面上没有别的可点元素时,用户去点它是必然的,不是误解。
 *
 * 「不给一个必然 404 的按钮」是对的,但不能因此让整张卡片变成
 * 看得见摸不着的空壳 —— 功能不可用时,至少要给一件用户能做的事。
 *
 * 而这件事是现成的:安装地址只需要应用名,**用户自己知道那个名字**,
 * 它就印在 GitHub App 的设置页上,也在应用主页的网址里。
 * 让他填一次,比让他去改环境变量再等一次部署快得多。
 */
export function GitManualConnect() {
  const [state, action] = useActionState<ConnectState, FormData>(
    connectViaSlug,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <label className="text-fg-secondary text-caption" htmlFor="git-app-slug">
        输入 GitHub App 的名称,直接前往安装
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="git-app-slug"
          name="slug"
          placeholder="例如:zhiyi-ai-repo"
          className="min-w-0 flex-1"
        />
        <SubmitButton size="sm" pendingText="查证中…">
          <Icon name="link" size={14} />
          前往安装
        </SubmitButton>
      </div>
      <p className="text-fg-tertiary text-label">
        它出现在应用主页的网址里 —— github.com/apps/<span className="text-fg-secondary">这一段</span>。
        填错会当场告诉你,不会把你甩到 GitHub 的 404 页面。
      </p>
      {state.error && (
        <p className="text-error text-label">{state.error}</p>
      )}
    </form>
  );
}
