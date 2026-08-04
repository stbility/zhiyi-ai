import { cn } from "@/lib/cn";

export type StatusTone = "neutral" | "success" | "warning" | "error";

export interface StatusLabelProps {
  tone?: StatusTone | undefined;
  children: string;
  className?: string | undefined;
}

const DOT: Record<StatusTone, string> = {
  neutral: "bg-fg-tertiary",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
};

/**
 * 连接状态指示:一个小圆点 + 一句话。**没有边框、没有底色。**
 *
 * 为什么不用 Badge:
 * 用户反复点集成卡片上那个「未连接」,点不动,反复来问「这个按钮坏了」。
 * 我起先回答「它按设计就是状态标签,本来就不可点」—— 这话技术上没错,
 * 但它是在争辩定义,而不是解决问题。
 *
 * Badge 是圆角 + 边框 + 底色的小方块,**长得就是按钮**。
 * 它放在标签云里没问题(那里没人指望能点),但放在一张卡片的标题旁边、
 * 而卡片正是用来「连接」某个东西的时候,它就落在了用户眼里
 * 最该点的那个位置上。去点它是必然的,不是误解。
 *
 * 圆点 + 文字是状态的通用写法,没有任何可点的暗示 ——
 * 分歧从源头上就不会产生。aria-hidden 是因为圆点只是颜色冗余,
 * 文字本身已经把状态说全了,读屏念一遍就够。
 */
export function StatusLabel({
  tone = "neutral",
  children,
  className,
}: StatusLabelProps) {
  return (
    <span
      className={cn(
        "text-fg-secondary font-zh text-label inline-flex items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])}
      />
      {children}
    </span>
  );
}
