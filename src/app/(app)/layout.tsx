import { redirect } from "next/navigation";

import { AppChrome } from "@/components/app/AppChrome";
import {
  getCurrentOrganization,
  getMyOrganizations,
  getProfile,
} from "@/lib/db/queries";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * 应用区布局。
 *
 * 服务端再次校验登录状态 —— 中间件是第一道,但不能作为唯一一道:
 * 中间件的 matcher 可能被改漏,而这里的检查与数据读取在同一处,不会脱节。
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [profile, organizations, currentOrg] = await Promise.all([
    getProfile(),
    getMyOrganizations(),
    getCurrentOrganization(),
  ]);

  const displayName =
    profile?.displayName ?? user.email?.split("@")[0] ?? "用户";

  return (
    <AppChrome
      displayName={displayName}
      organizationName={currentOrg?.name ?? organizations[0]?.name ?? null}
      organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
      currentOrganizationId={currentOrg?.id}
    >
      {children}
    </AppChrome>
  );
}
