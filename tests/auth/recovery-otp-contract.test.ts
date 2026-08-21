import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecoveryOtpForm } from "@/components/auth/RecoveryOtpForm";

/**
 * Recovery OTP 契约测试(最终 Recovery UX)。
 *
 * 产品最终 UX = 邮箱 8 位验证码,不再是「点击邮件链接进入重置页」:
 *
 *   输入注册邮箱 → resetPasswordForEmail() 发 Recovery 邮件(含 8 位 OTP)
 *   → 输入验证码 → verifyOtp({ email, token, type: "recovery" })
 *   → Recovery Session → updateUser({ password }) → 新密码登录
 *
 * 全部复用 Supabase Auth 官方能力,无自定义 OTP 系统。
 * 验证码位数以生产 mailer_otp_length = 8 为准(实证)。
 *
 * 这是源码契约断言,防止:
 *   - Recovery 主流程回退成旧的 Link UX
 *   - 引入自定义 OTP 表 / token / 服务
 *   - 写死管理员邮箱 / UUID(用户无关性)
 */

const RECOVERY_FORM = resolve(
  __dirname,
  "../../src/components/auth/RecoveryOtpForm.tsx",
);
const AUTH_FORM = resolve(
  __dirname,
  "../../src/components/auth/AuthForm.tsx",
);

const recovery = readFileSync(RECOVERY_FORM, "utf8");
const authForm = readFileSync(AUTH_FORM, "utf8");

describe("Recovery OTP 契约", () => {
  it("1. resetPasswordForEmail() 仍为 Recovery 发信入口", () => {
    expect(recovery).toMatch(/resetPasswordForEmail\(email\)/);
  });

  it("2. verifyOtp(type=recovery) 存在且类型正确", () => {
    expect(recovery).toMatch(/verifyOtp\(/);
    expect(recovery).toMatch(/type:\s*"recovery"/);
  });

  it("3. Recovery OTP 使用 email + token 验证", () => {
    // verifyOtp 调用必须同时携带 email 与 token
    const call = recovery.match(/verifyOtp\(\{[\s\S]{0,200}?\}\)/);
    expect(call).not.toBeNull();
    expect(call![0]).toMatch(/email/);
    expect(call![0]).toMatch(/token/);
  });

  it("4. OTP 验证成功后进入 Recovery Session 改密阶段", () => {
    // verifyOtp 成功(auth-js _saveSession 建立 Recovery Session)后进入 password 屏
    expect(recovery).toMatch(/setPhase\("password"\)/);
    expect(recovery).toMatch(/验证成功,请设置统一登录新密码/);
  });

  it("5. updateUser({ password }) 为最终改密动作", () => {
    expect(recovery).toMatch(/updateUser\(\{\s*password\s*\}\)/);
  });

  it("6. Recovery 不依赖固定用户 —— 身份来自用户输入 email", () => {
    // 邮箱只来自表单输入,验证码来自用户输入;无任何固定用户引用
    expect(recovery).toMatch(/resetPasswordForEmail\(email\)/);
    expect(recovery).not.toMatch(/@gmail\.com|@protonmail|@qq\.com/);
    expect(recovery).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it("7. 不存在管理员 email / UUID 写死(全认证代码域)", () => {
    for (const src of [recovery, authForm]) {
      expect(src).not.toMatch(/vivian6499/i);
      expect(src).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    }
  });

  it("OTP 长度以生产 mailer_otp_length=8 为准", () => {
    expect(recovery).toMatch(/OTP_LENGTH = 8/);
    expect(recovery).toMatch(/8 位/);
  });

  it("不再使用旧 Recovery Link 主流程(resetPasswordForEmail 的 redirectTo)", () => {
    // 旧 Link 主流程契约已删除:AuthForm 不再调用 resetPasswordForEmail
    // (精确匹配代码调用形态,不匹配注释中的历史叙述文字)
    expect(authForm).not.toMatch(/supabase\.auth\.resetPasswordForEmail/);
    // RecoveryOtpForm 发码时不带 redirectTo(模板无链接,纯 OTP)
    expect(recovery).not.toMatch(/redirectTo:/);
  });
});

// ============================================================
// DOM 状态机实测(jsdom 渲染 + 交互,不新增文件,在白名单测试内)
// 验证三屏真实转换:邮箱屏 → 验证码屏 → 新密码屏 → 完成
// ============================================================

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    resetPasswordForEmail: vi.fn(),
    verifyOtp: vi.fn(),
    updateUser: vi.fn(),
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  createSupabaseBrowserClient: () => ({ auth: mockAuth }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

function renderForm() {
  return render(createElement(RecoveryOtpForm));
}

describe("RecoveryOtpForm DOM 状态机(jsdom 实测)", () => {
  beforeEach(() => {
    mockAuth.resetPasswordForEmail.mockReset();
    mockAuth.verifyOtp.mockReset();
    mockAuth.updateUser.mockReset();
  });

  it("第一屏:邮箱输入框 + 发送验证码按钮", () => {
    renderForm();
    expect(screen.getByLabelText(/邮箱/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "发送验证码" }),
    ).toBeTruthy();
    // 第一屏没有验证码输入框
    expect(screen.queryByLabelText(/验证码/)).toBeNull();
  });

  it("提交邮箱 → resetPasswordForEmail(email) → 第二屏(8 位验证码输入框出现)", async () => {
    mockAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
    renderForm();

    fireEvent.change(screen.getByLabelText(/邮箱/), {
      target: { value: "otp-e2e@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

    await waitFor(() => {
      expect(mockAuth.resetPasswordForEmail).toHaveBeenCalledWith(
        "otp-e2e@example.com",
      );
    });

    // 状态转换:验证码输入框出现,且限制 8 位
    const codeInput = (await screen.findByLabelText(/验证码/)) as HTMLInputElement;
    expect(codeInput.maxLength).toBe(8);
    expect(screen.getByRole("button", { name: "验证" })).toBeTruthy();
    expect(screen.getByText(/验证码已发送至/)).toBeTruthy();
    expect(screen.getByText(/秒后可重新发送/)).toBeTruthy();
    expect(screen.getByText(/更换邮箱/)).toBeTruthy();
  });

  it("输入 8 位验证码 → verifyOtp({email, token, type:recovery}) → 第三屏(新密码)", async () => {
    mockAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
    mockAuth.verifyOtp.mockResolvedValue({ error: null });
    renderForm();

    fireEvent.change(screen.getByLabelText(/邮箱/), {
      target: { value: "otp-e2e@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    const codeInput = await screen.findByLabelText(/验证码/);

    fireEvent.change(codeInput, { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    await waitFor(() => {
      expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
        email: "otp-e2e@example.com",
        token: "12345678",
        type: "recovery",
      });
    });

    // 第三屏:新密码 / 确认新密码 / 重置密码
    expect(await screen.findByLabelText(/^新密码/)).toBeTruthy();
    expect(screen.getByLabelText(/^确认新密码/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重置密码" })).toBeTruthy();
  });

  it("第三屏提交 → updateUser({password}) → 密码已更新(完成屏)", async () => {
    mockAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
    mockAuth.verifyOtp.mockResolvedValue({ error: null });
    mockAuth.updateUser.mockResolvedValue({ error: null });
    renderForm();

    fireEvent.change(screen.getByLabelText(/邮箱/), {
      target: { value: "otp-e2e@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    const codeInput = await screen.findByLabelText(/验证码/);
    fireEvent.change(codeInput, { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    const newPassword = await screen.findByLabelText(/^新密码/);
    fireEvent.change(newPassword, { target: { value: "NewPass123!" } });
    fireEvent.change(screen.getByLabelText(/^确认新密码/), {
      target: { value: "NewPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));

    await waitFor(() => {
      expect(mockAuth.updateUser).toHaveBeenCalledWith({
        password: "NewPass123!",
      });
    });
    expect(await screen.findByText("密码已更新")).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回登录" })).toBeTruthy();
  });

  it("验证码过期 → 提示「验证码已过期,请重新发送」", async () => {
    mockAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
    mockAuth.verifyOtp.mockResolvedValue({
      error: { message: "Email link is invalid or has expired" },
    });
    renderForm();

    fireEvent.change(screen.getByLabelText(/邮箱/), {
      target: { value: "otp-e2e@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    const codeInput = await screen.findByLabelText(/验证码/);
    fireEvent.change(codeInput, { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    expect(
      await screen.findByText("验证码已过期,请重新发送。"),
    ).toBeTruthy();
  });

  it("验证码位数不足 → 提示请输入 8 位验证码", async () => {
    mockAuth.resetPasswordForEmail.mockResolvedValue({ error: null });
    renderForm();

    fireEvent.change(screen.getByLabelText(/邮箱/), {
      target: { value: "otp-e2e@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    const codeInput = await screen.findByLabelText(/验证码/);

    fireEvent.change(codeInput, { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    expect(
      await screen.findByText("请输入 8 位验证码。"),
    ).toBeTruthy();
    // 位数不足时不调用 verifyOtp
    expect(mockAuth.verifyOtp).not.toHaveBeenCalled();
  });
});
