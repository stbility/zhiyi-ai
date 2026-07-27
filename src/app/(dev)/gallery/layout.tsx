import { notFound } from "next/navigation";

/**
 * 组件走查页仅在开发环境可访问。生产构建下直接 404,
 * 避免这类内部页面对外暴露。
 */
export default function GalleryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
