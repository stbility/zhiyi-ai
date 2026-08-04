import Link from "next/link";
import type { ReactNode } from "react";

import {
  buttonClasses,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/primitives/Button";

export interface LinkButtonProps {
  href: string;
  children?: ReactNode | undefined;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** 外部地址。true 时渲染原生 <a> 并新开标签页 */
  external?: boolean | undefined;
  title?: string | undefined;
  className?: string | undefined;
  /**
   * 点击时的附带动作(比如关掉抽屉)。
   *
   * 注意它**不替代跳转** —— 跳转由 href 完成。放在这里是为了让
   * 「点了就关抽屉」这类收尾动作有个正当位置,而不是逼着调用方
   * 退回去手写 <Link className={buttonClasses(...)}>。
   */
  onClick?: (() => void) | undefined;
}

/**
 * 长得像按钮的链接。
 *
 * 为什么要有这个组件,而不是各处自己拼 `<a className={buttonClasses(...)}>`:
 *
 * 视觉上两者确实一样 —— 我用浏览器实测过计算样式,`<button>` 与套了同一套
 * 类名的 `<a>` 在主要/次要两种形态下颜色和背景完全相同,全局的
 * `a{color:...}` 也没有压过 Tailwind。所以这不是「现在看起来不对」。
 *
 * 问题在**构造**:别处用的是 <Button> 组件,而 Git 卡片是手工抄类名。
 * 一旦 Button 内部有任何演进(加 loading 态、改 focus 环、换 disabled 处理),
 * 组件那边自动跟上,手抄的那份原地不动 —— 不一致是迟早的,只是还没发生。
 *
 * 用户的原话是「不是原生组件,是拼接的」。他说的正是这件事。
 *
 * 为什么不直接给 Button 加 href:那会让一个组件同时承担 <button> 和 <a>
 * 两种语义,类型上要处理两套互斥的属性,调用方也容易写出
 * 「带 href 却又传 onClick」这种含糊的东西。分成两个组件,
 * 各自的语义是确定的:要跳转就用这个,要触发动作就用 Button。
 */
export function LinkButton({
  href,
  children,
  variant,
  size,
  external,
  title,
  className,
  onClick,
}: LinkButtonProps) {
  const classes = buttonClasses({ variant, size, className });

  // 外部地址走原生 <a>:next/link 的预取对站外地址没有意义,
  // 而且新开标签页必须带 rel="noopener" —— 不带的话新页面能通过
  // window.opener 操作我们这一页。
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className={classes}
        onClick={onClick}
      >
        {children}
      </a>
    );
  }

  return (
    // exactOptionalPropertyTypes 下不能把 undefined 直接传给 Link 的可选属性,
    // 所以按存在与否展开 —— 这比给整个组件放宽类型好
    <Link
      href={href}
      className={classes}
      {...(title !== undefined ? { title } : {})}
      {...(onClick !== undefined ? { onClick } : {})}
    >
      {children}
    </Link>
  );
}
