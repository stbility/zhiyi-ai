"use client";

import { useEffect } from "react";

import { Button } from "@/components/primitives/Button";

/**
 * 应用区错误边界。
 *
 * 为什么需要它:客户端渲染一旦抛错,React 会把整棵树卸载 —— 用户看到的就是
 * 一片白屏,而服务端日志干干净净(请求是 200),排查时完全无从下手。
 * 助手页就出过这种情况:200、日志无异常、组件单测通过,却白屏。
 *
 * 有了边界,同样的故障会显示成一条带原文的错误,而不是空白。
 * 错误原文必须原样给出 —— 笼统的「出错了」等于把唯一的线索也丢掉。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 同时写到控制台,方便用户直接把整段复制给我们
    console.error("[智一 AI] 页面渲染失败:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 md:px-8">
      <div className="border-error-tint bg-error-tint rounded-card font-zh border p-5">
        <h2 className="text-error text-body mb-2 font-medium">
          这个页面没能正常加载
        </h2>
        <p className="text-fg-secondary text-caption mb-3 leading-[1.7]">
          下面是错误原文。把它发给管理员即可定位问题,不需要你再复现一遍。
        </p>
        <pre className="bg-surface-2 border-border-default text-fg-secondary text-label rounded-control overflow-x-auto border p-3 font-mono whitespace-pre-wrap">
          {error.message || "(错误没有提供说明)"}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
      </div>

      <div className="mt-3 flex gap-2">
        <Button onClick={reset}>重试</Button>
        <Button
          variant="secondary"
          onClick={() => {
            window.location.href = "/today";
          }}
        >
          回到今日
        </Button>
      </div>
    </div>
  );
}
