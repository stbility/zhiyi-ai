"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/primitives/Button";
import { Icon } from "@/components/icons/Icon";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import {
  disconnectGit,
  type DisconnectState,
} from "@/app/(app)/settings/integrations/git-actions";

/**
 * 断开 Git 连接。
 *
 * 对齐 ChatGPT / Codex 的 GitHub 连接器:已连接状态下**两个动作都要有** ——
 * Choose repositories(改仓库范围)和 Disconnect(断开)。
 * 来源:help.openai.com/en/articles/11145903-connecting-github-to-chatgpt
 * 此前我们只做了前者,连上之后就没有退路,只能自己摸到 GitHub 后台去卸载。
 *
 * 两步确认,而不是弹 confirm():
 * 断开会真的调 DELETE /app/installations/{id} 把 GitHub 侧的授权收回,
 * 收回之后要恢复得重新走一遍安装流程。一下点掉的代价太大。
 * 用原生 confirm() 的话样式不受控、移动端体验差,而且没法把
 * 「会发生什么」写清楚 —— 而这里恰恰需要写清楚。
 */
export function GitDisconnect({
  installationId,
  accountLogin,
}: {
  installationId: string;
  accountLogin: string | null;
}) {
  const [state, action] = useActionState<DisconnectState, FormData>(
    disconnectGit,
    {},
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {!confirming ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setConfirming(true)}
        >
          <Icon name="x" size={14} />
          断开连接
        </Button>
      ) : (
        <div className="border-border-default rounded-control flex flex-col gap-2 border border-dashed p-3">
          {/* 说清楚会发生什么、以及怎么恢复。
              「确定要断开吗?」是句废话 —— 用户点之前就知道自己要断开,
              他不知道的是这一下到底动了什么。 */}
          <p className="text-fg-secondary text-caption">
            将向 GitHub 发送卸载请求,收回本应用对
            {accountLogin ? `「${accountLogin}」` : "该账号"}下所有仓库的访问权限,
            并删除本站的连接记录。之后智能体读不到你的代码。
            要恢复得重新安装一次。
          </p>
          <div className="flex flex-wrap gap-2">
            <form action={action}>
              <input
                type="hidden"
                name="installationId"
                value={installationId}
              />
              <SubmitButton
                variant="secondary"
                size="sm"
                pendingText="断开中…"
              >
                确认断开
              </SubmitButton>
            </form>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {state.error && <p className="text-error text-label">{state.error}</p>}
      {/* 「GitHub 侧收回了、本地记录没删」既不是成功也不是失败。
          归到任何一边都会让用户做错下一步动作 —— 当成失败他会跑去
          GitHub 再卸载一次(那边已经没有了),当成成功他会以为一切正常。 */}
      {state.warning && (
        <p className="text-warning text-label">{state.warning}</p>
      )}
    </div>
  );
}
