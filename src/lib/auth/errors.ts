/**
 * Supabase 认证错误的中文化。
 *
 * Supabase 返回的是英文原文,直接抛给用户既看不懂也不知道该怎么办。
 * 这里只做「翻译 + 给出下一步」,不改变错误的事实,更不把失败粉饰成成功。
 *
 * 未收录的错误保留原文并附上说明 —— 宁可让用户看到英文,也不能显示一句
 * 笼统的「操作失败」把真实原因盖掉,那会让问题无法排查。
 */

export interface AuthErrorMessage {
  /** 面向用户的中文说明 */
  readonly message: string;
  /** 可操作的下一步。属于服务端配置问题时,指向运维而非让用户白等。 */
  readonly hint?: string;
  /** 是否为服务端配置问题(而非用户输入问题) */
  readonly isServerConfig: boolean;
}

interface Rule {
  readonly match: RegExp;
  readonly message: string;
  readonly hint?: string;
  readonly isServerConfig?: boolean;
}

const RULES: readonly Rule[] = [
  {
    // Supabase 内置邮件服务仅供测试,免费额度每小时仅数封,生产必须接自有 SMTP
    match: /email rate limit exceeded|over_email_send_rate_limit/i,
    message: "邮件发送已达上限,暂时无法完成注册。",
    hint: "这是邮件服务的配额限制,不是您的操作问题。请稍后再试,或联系管理员配置正式的邮件服务。",
    isServerConfig: true,
  },
  {
    match: /error sending confirmation (mail|email)/i,
    message: "验证邮件发送失败。",
    hint: "邮件服务未正确配置,请联系管理员。",
    isServerConfig: true,
  },
  {
    match: /invalid login credentials/i,
    message: "邮箱或密码不正确。",
    hint: "请检查后重试;若忘记密码,可通过下方链接重置。",
  },
  {
    match: /email not confirmed/i,
    message: "邮箱尚未验证。",
    hint: "请前往邮箱点击验证链接后再登录。",
  },
  {
    match: /user already registered/i,
    message: "该邮箱已注册。",
    hint: "请直接登录,或使用找回密码。",
  },
  {
    match: /email address .* is invalid|email_address_invalid/i,
    message: "该邮箱地址无法使用。",
    hint: "请换一个真实可收信的邮箱地址。",
  },
  {
    match: /password should be at least/i,
    message: "密码长度不足。",
    hint: "请设置至少 8 位的密码。",
  },
  {
    match: /weak.?password|password is too weak/i,
    message: "密码强度不足。",
    hint: "请混合使用大小写字母、数字与符号。",
  },
  {
    match: /for security purposes.*after (\d+) seconds/i,
    message: "操作过于频繁。",
    hint: "出于安全考虑需要稍等片刻再试。",
  },
  {
    match: /provider is not enabled|unsupported provider/i,
    message: "该登录方式尚未启用。",
    hint: "请改用邮箱密码登录,或联系管理员启用该登录方式。",
    isServerConfig: true,
  },
  {
    match: /token has expired|otp_expired/i,
    message: "链接已过期。",
    hint: "请重新发起,获取新的链接。",
  },
  {
    match: /same.?password|new password should be different/i,
    message: "新密码不能与旧密码相同。",
  },
  {
    match: /failed to fetch|networkerror|network request failed/i,
    message: "无法连接认证服务。",
    hint: "请检查网络后重试。",
  },
];

export function translateAuthError(raw: unknown): AuthErrorMessage {
  // 上游未必给字符串:可能是空对象、undefined,或整个 Error 实例。
  // 直接渲染会得到 "{}" 或 "[object Object]" —— 对用户毫无意义。
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
        ? raw.message
        : typeof raw === "object" && raw !== null && "message" in raw
          ? String((raw as { message: unknown }).message)
          : "";

  if (text.trim() === "" || text === "{}" || text === "[object Object]") {
    return {
      message: "操作未能完成,服务端没有返回具体原因。",
      hint: "请稍后重试;若反复出现,请把这一情况告知管理员。",
      isServerConfig: false,
    };
  }

  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return {
        message: rule.message,
        ...(rule.hint === undefined ? {} : { hint: rule.hint }),
        isServerConfig: rule.isServerConfig === true,
      };
    }
  }

  // 未收录:保留原文,不粉饰、不吞掉
  return {
    message: text,
    hint: "如果反复出现,请把这条提示提供给管理员。",
    isServerConfig: false,
  };
}
