import type { Metadata } from "next";
import "./globals.css";

/**
 * 字体不在此处通过 next/font 加载。
 * 字体栈由设计系统的 tokens/typography.css 定义,webfont 由 tokens/fonts.css
 * 经 Google Fonts CDN 引入 —— 见 globals.css 顶部说明。此处引入 next/font 会
 * 产生第二套字体族名,与设计系统 token 冲突。
 */

export const metadata: Metadata = {
  title: "智一 AI",
  description: "面向个人知识工作的 AI 工作流操作系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/*
          webfont 走非阻塞加载。

          此前它是 tokens/fonts.css 里的一行 @import,而 CSS 的 @import 阻塞渲染,
          fonts.googleapis.com 在中国大陆又不通 —— 浏览器只能一直等到 TCP 超时,
          首屏渲染与脚本执行被一起卡住,水合迟迟完不成。表现就是「页面很慢、
          按钮看着能点却没反应、连点几下才一起生效」。

          media="print" 的样式表不参与首屏渲染,永远不会阻塞;页面加载完成后
          再切成 all。取得到就照常生效,取不到则一秒都不等 ——
          反正 --font-zh 的第一顺位是系统自带的 PingFang SC,中文本来就不依赖它。
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* 规则前提是 Pages Router 的 pages/_document.js —— 它警告「只会对单个
            页面生效」。这里是 App Router 的根布局,对所有页面生效,前提不成立。
            而且这条 link 必须留在这里:它的价值恰恰是 media="print" 的非阻塞
            加载,交给 next/font 反而会重新回到阻塞路径上。 */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          id="zy-webfonts"
          rel="stylesheet"
          media="print"
          // media 会被下面那段内联脚本在 load 之后改成 all —— 这是有意的,
          // 不是渲染不一致。不标的话 React 会在控制台报一条水合告警,
          // 而那条告警会把真正的问题淹掉。
          suppressHydrationWarning
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />

        {/*
          在首帧绘制前把主题落到 <html> 上。
          放在 React 之外同步执行,否则浅色用户每次进页面都会先闪一下深色 ——
          那比没有浅色更难受。读不到或出错就什么都不做,回落到默认深色。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var c=localStorage.getItem('zhiyi-theme');var d=c==='dark'||(c!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}
// 页面全部加载完再让 webfont 生效。挂在 load 上而不是 DOMContentLoaded,
// 确保它排在首屏渲染与水合之后,任何情况下都不抢占关键路径。
try{addEventListener('load',function(){var l=document.getElementById('zy-webfonts');if(l){l.media='all'}})}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-canvas text-fg font-zh flex min-h-full flex-col">
        {children}
      </body>
    </html>
  );
}
