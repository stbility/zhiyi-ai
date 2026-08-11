"use client";

import { useTransition } from "react";

import { Icon } from "@/components/icons/Icon";
import { cn } from "@/lib/cn";

/**
 * 组织切换器(阶段 2 收口,2026-08-11)。
 *
 * 纯展示组件:列出组织,选择后调用 onSwitch(id)。server action 的
 * 调用由父组件(AppChrome 的调用方)通过动态 import 处理,避免
 * client 组件静态 import "use server" 模块导致 server-only 泄漏
 * (nav-links.test.tsx 实测会炸)。
 *
 * 只有一个组织时不渲染(没得切)。
 */
export function OrganizationSwitcher({
  organizations,
  currentOrganizationId,
  onSwitch,
}: {
  organizations: readonly { id: string; name: string }[];
  currentOrganizationId: string;
  onSwitch: (organizationId: string) => Promise<void> | void;
}) {
  const [pending, startTransition] = useTransition();

  if (organizations.length <= 1) return null;

  const current =
    organizations.find((o) => o.id === currentOrganizationId) ??
    organizations[0];

  return (
    <div className="relative">
      <select
        value={current?.id ?? ""}
        disabled={pending}
        onChange={(e) => {
          const orgId = e.target.value;
          if (!orgId || orgId === currentOrganizationId) return;
          startTransition(async () => {
            await onSwitch(orgId);
            window.location.reload();
          });
        }}
        aria-label="切换组织"
        className={cn(
          "bg-surface-2 text-fg font-zh text-caption rounded-control border-border-default",
          "hover:border-border-focus focus:border-border-focus max-w-40 cursor-pointer",
          "border px-2 py-1.5 pr-7 outline-none transition-colors",
          pending && "opacity-60",
        )}
      >
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <Icon
        name="today"
        size={12}
        className="text-fg-tertiary pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
      />
    </div>
  );
}
