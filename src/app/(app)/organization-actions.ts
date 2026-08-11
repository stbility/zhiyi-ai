"use server";

import { z } from "zod";

import { rememberOrganization } from "@/lib/db/queries";

const orgSchema = z.string().uuid("组织标识无效");

/**
 * 切换当前组织(2026-08-11)。
 *
 * 写 cookie(zhiyi_current_org),由 getCurrentOrganization() 读取。
 * 安全性:cookie 只存 id;页面读取时会校验「当前用户仍属于该组织」,
 * 不属于则回退第一个 —— 被移出组织不会越权。
 */
export async function switchOrganization(organizationId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const parsed = orgSchema.safeParse(organizationId);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数不合法" };
  }

  await rememberOrganization(parsed.data);
  return { ok: true };
}
