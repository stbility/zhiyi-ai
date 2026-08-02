import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/log";

/**
 * 取服务商密文。
 *
 * 迁移 0018 之后,api_key_cipher / credential_cipher 对 authenticated 与 anon
 * 都不可读了 —— 否则任何组织成员(哪怕只是 viewer)都能直接
 * GET /rest/v1/ai_providers?select=api_key_cipher 把全部密文拉走。
 *
 * 所以密文只能走 service_role 取。而 service_role 绕过全部 RLS,
 * 于是**授权判断必须在调用这里之前完成**:调用方要先用用户身份客户端
 * 读到那一行(读得到就说明 RLS 认可他有权访问),再用这里取密文。
 *
 * 这个顺序不能颠倒。反过来先取密文再判断,等于把 RLS 架空了。
 */

/** 调用前必须已经用用户身份确认过访问权 —— 见本文件顶部说明 */
export async function loadProviderCipher(
  providerId: string,
): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    logger.error(
      { providerId },
      "未配置 service role,无法读取服务商密钥密文",
    );
    return null;
  }

  const { data, error } = await admin
    .from("ai_providers")
    .select("api_key_cipher")
    .eq("id", providerId)
    .maybeSingle();

  if (error || !data) {
    logger.error(
      { providerId, dbError: error?.message },
      "读取服务商密钥密文失败",
    );
    return null;
  }
  return (data.api_key_cipher as string | null) ?? null;
}

/** 同上,集成(Tavily 等)的凭据密文 */
export async function loadIntegrationCipher(
  integrationId: string,
): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    logger.error({ integrationId }, "未配置 service role,无法读取集成凭据");
    return null;
  }

  const { data, error } = await admin
    .from("integrations")
    .select("credential_cipher")
    .eq("id", integrationId)
    .maybeSingle();

  if (error || !data) {
    logger.error(
      { integrationId, dbError: error?.message },
      "读取集成凭据密文失败",
    );
    return null;
  }
  return (data.credential_cipher as string | null) ?? null;
}
