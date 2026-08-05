"use client";

import { useActionState } from "react";

import { Icon } from "@/components/icons/Icon";
import { SubmitButton } from "@/components/primitives/SubmitButton";
import {
  testGitAccess,
  type GitTestState,
} from "@/app/(app)/settings/integrations/git-actions";

/**
 * 一键实证:真的去 GitHub 拉一次仓库列表。
 *
 * 【为什么这个按钮值得存在】
 * 用户问「智能体真的能工作吗」。在这之前,唯一的验证方式是**跑一轮智能体** ——
 * 要选模型、写提示词、等它自己决定去调工具。任何一环出问题都会被误读成
 * 「Git 不通」:模型不行、提示词不对、工具没被选中,表现是一样的。
 *
 * 而「已连接」这个状态本身也只是推断 —— 它证明我们问到了账号名,
 * 不证明**能列出仓库**。两者之间还隔着一次换令牌和一次分页拉取。
 *
 * 这个按钮把那段路真的走一遍,并把**拉回来的仓库名**摆出来。
 * 仓库名是伪造不了的东西,它同时回答了两个问题:
 * 链路通不通,以及智能体能碰哪些仓库(用的是同一份白名单)。
 */
export function GitTestAccess() {
  const [state, action] = useActionState<GitTestState, FormData>(
    testGitAccess,
    {},
  );

  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <SubmitButton variant="secondary" size="sm" pendingText="正在拉取…">
          <Icon name="refresh" size={14} />
          测试仓库读取
        </SubmitButton>
      </form>

      {state.error && (
        <p className="border-error-tint bg-error-tint text-error rounded-control text-caption p-3">
          {state.error}
        </p>
      )}

      {state.ok && state.repos && (
        <div className="border-success bg-success-tint rounded-control p-3">
          {state.repos.length === 0 ? (
            // 「连上了但一个仓库都没授权」是**成功**,不是失败 ——
            // 链路是通的,只是授权范围是空的。混成一句「失败」的话,
            // 用户会去查凭据,而该改的是 GitHub 上的仓库勾选。
            <p className="text-success text-caption">
              连接正常,但这次安装**没有授权任何仓库**。
              到 GitHub 上用「调整授权的仓库」勾选之后,智能体才碰得到代码。
            </p>
          ) : (
            <>
              <p className="text-success text-caption mb-1.5">
                连接正常。智能体当前可读写这 {state.repos.length} 个仓库:
              </p>
              <ul className="flex flex-col gap-0.5">
                {state.repos.map((r) => (
                  <li
                    key={r}
                    className="text-fg-secondary text-label font-mono break-all"
                  >
                    {r}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
