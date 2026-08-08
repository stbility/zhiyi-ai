"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runEvalSuite } from "@/lib/eval/run";

export interface EvalActionState {
  readonly ok?: string;
  readonly error?: string;
}

/** 一键跑完 20 条用例,结果落 eval_runs */
export async function startEval(): Promise<EvalActionState> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "认证服务未配置。" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "请先登录。" };

  try {
    const cookieHeader = (await cookies()).toString();
    const result = await runEvalSuite(supabase, {
      userId: user.id,
      cookieHeader,
      versionSha:
        process.env["VERCEL_GIT_COMMIT_SHA"]?.slice(0, 7) ??
        process.env["GIT_COMMIT_SHA"]?.slice(0, 7) ??
        "dev",
      model: "用户默认模型",
    });
    revalidatePath("/settings/eval");
    const { status, passed, total, skipped } = result.summary;
    return {
      ok:
        status === "partial"
          ? `评测完成(部分):通过 ${passed}/${total - skipped},${skipped} 条因预算未跑。`
          : `评测完成:通过 ${passed}/${total}。`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
