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
          在首帧绘制前把主题落到 <html> 上。
          放在 React 之外同步执行,否则浅色用户每次进页面都会先闪一下深色 ——
          那比没有浅色更难受。读不到或出错就什么都不做,回落到默认深色。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var c=localStorage.getItem('zhiyi-theme');var d=c==='dark'||(c!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-canvas text-fg font-zh flex min-h-full flex-col">
        {children}
      </body>
    </html>
  );
}
