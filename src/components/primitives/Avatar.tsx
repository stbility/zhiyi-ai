/* eslint-disable @next/next/no-img-element -- 头像为任意外部 URL,不走 next/image 优化 */
import { cn } from "@/lib/cn";

export interface AvatarProps {
  name?: string;
  /** 边长,单位 px。设计系统默认 32。 */
  size?: number;
  src?: string;
  className?: string;
}

export function Avatar({ name = "", size = 32, src, className }: AvatarProps) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("rounded-full object-cover", className)}
      />
    );
  }

  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      className={cn(
        "font-zh bg-brand-tint text-brand inline-flex items-center justify-center rounded-full font-semibold",
        className,
      )}
    >
      {name.trim().slice(0, 1)}
    </span>
  );
}
