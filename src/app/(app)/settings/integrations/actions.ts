"use server";

import { revalidatePath } from "next/cache";

import { loadIntegrationCipher } from "@/lib/ai/credentials";
import { z } from "zod";

import {
  encryptSecret,
  isEncryptionAvailable,
  maskApiKey,
} from "@/lib/crypto/secret-box";
import { getIntegrationSpec } from "@/lib/integrations/registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 集成的增删与连接测试。
 *
 * 凭据处理与模型密钥完全一致:提交后立刻加密落库,数据库无明文,
 * 界面只显示掩码,绝不下发到浏览器。
 *
 * 「测试连接」是真调一次对方接口 —— 填了密钥不等于能用,这一点在模型服务
 * 那边已经反复验证过:不真调一次,用户会在真正需要它的时候才发现是坏的。
 */

export interface IntegrationActionState {
  readonly error?: string;
  readonly hint?: string;
  readonly ok?: string;
}

const addSchema = z.object({
  organizationId: z.string().uuid("组织标识无效"),
  kind: z.string().trim().min(1),
  credential: z.string().trim().min(1, "请填写密钥"),
});

export async function addIntegration(
  _prev: IntegrationActionState,
  formData: FormData,
): Promise<IntegrationActionState> {
  if (!isEncryptionAvailable()) {
    return {
      error: "密钥加密不可用,拒绝保存。",
      hint: "ENCRYPTION_KEY 未配置或格式不正确。绝不以明文存储密钥。",
    };
  }

  const parsed = addSchema.safeParse({
    organizationId: formData.get("organizationId"),
    kind: formData.get("kind"),
    credential: formData.get("credential"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "输入不合法" };
  }

  const spec = getIntegrationSpec(parsed.data.kind);
  if (!spec) return { error: "未知的集成类型。" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "登录状态已失效,请重新登录。" };

  const { error } = await supabase.from("integrations").upsert(
    {
      organization_id: parsed.data.organizationId,
      kind: spec.kind,
      display_name: spec.label,
      credential_cipher: encryptSecret(parsed.data.credential),
      credential_masked: maskApiKey(parsed.data.credential),
      created_by: user.id,
      // 换了新密钥,旧的测试结果就不再作数
      last_tested_at: null,
      last_test_ok: null,
      last_test_error: null,
    },
    { onConflict: "organization_id,kind" },
  );

  if (error) {
    if (error.code === "42501") {
      return {
        error: "没有权限配置集成。",
        hint: "只有组织的所有者或管理员可以配置。",
      };
    }
    return { error: error.message };
  }

  revalidatePath("/settings/integrations");
  revalidatePath("/assistant");
  return { ok: `已保存 ${spec.label}。建议立即测试连接,确认密钥可用。` };
}

const idSchema = z.object({ id: z.string().uuid() });

export async function deleteIntegration(
  _prev: IntegrationActionState,
  formData: FormData,
): Promise<IntegrationActionState> {
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { error, count } = await supabase
    .from("integrations")
    .delete({ count: "exact" })
    .eq("id", parsed.data.id);
  if (error) return { error: error.message };
  // 0 行被删 = RLS 把这次操作拦下了(PostgREST 在 0 行匹配时**不返回错误**)。
  // 此前只判 error,于是越权删除会得到一句「已删除。」—— 反馈与事实相反,
  // 用户以为删掉了,刷新一看还在。
  if ((count ?? 0) === 0) {
    return { error: "没有权限删除,或该记录已不存在。" };
  }

  revalidatePath("/settings/integrations");
  revalidatePath("/assistant");
  return { ok: "已删除。" };
}

/**
 * 真调一次对方接口来验证。
 *
 * 用一个固定的无害查询探一下 —— 消耗一次配额,但换来的是「这个密钥真的能用」
 * 这个事实。填了就认为能用,是需求明令禁止的伪装已接通。
 */
export async function testIntegration(
  _prev: IntegrationActionState,
  formData: FormData,
): Promise<IntegrationActionState> {
  const parsed = idSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: "标识无效" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };

  const { data: row } = await supabase
    .from("integrations")
    // 密文不在这里取,理由同 models/actions.ts
    .select("id, kind")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (!row) return { error: "未找到该集成。" };

  // 上一行读得到就说明 RLS 认可访问权 —— 之后才取密文
  const cipher = await loadIntegrationCipher(parsed.data.id);
  if (!cipher) return { error: "无法读取该集成的凭据,请重新填写。" };

  let ok = false;
  let failure: string | null = null;
  let sample = 0;

  if (row.kind === "tavily") {
    const { tavilySearch } = await import("@/lib/integrations/tavily");
    const outcome = await tavilySearch({
      credentialCipher: cipher,
      query: "今天的日期",
      maxResults: 3,
    });
    ok = outcome.ok;
    failure = outcome.error;
    sample = outcome.results.length;
  } else {
    failure = "该集成暂无验证方式。";
  }

  await supabase
    .from("integrations")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: ok,
      last_test_error: failure,
    })
    .eq("id", parsed.data.id);

  revalidatePath("/settings/integrations");
  revalidatePath("/assistant");

  if (!ok) return { error: `连接失败:${failure ?? "未知原因"}` };
  return { ok: `连接成功,真实检索返回 ${sample} 条结果。现在可以在助手页开启联网。` };
}
