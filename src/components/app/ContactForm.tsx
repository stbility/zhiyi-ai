"use client";

import { useActionState } from "react";

import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { TextArea } from "@/components/primitives/TextArea";
import {
  submitSalesLead,
  type LeadActionState,
} from "@/app/(app)/contact/actions";

/**
 * Enterprise 询价表单(P0-3)。
 *
 * 「联系销售」的落点:站内表单 → sales_leads 表 → 销售人工跟进。
 * 不再跳 Stripe 付款链接(此前硬编码 URL 与 Team 共用,且付款邮箱≠
 * 注册邮箱时订阅静默丢失)。
 *
 * 表单动作走 useActionState + FormData(与 SkillsManager 同模式):
 * 提交状态(ok/error)就地展示,不跳转。
 */
export function ContactForm() {
  const [state, action] = useActionState<LeadActionState, FormData>(
    submitSalesLead,
    {},
  );

  return (
    <form action={action} className="flex w-full max-w-2xl flex-col gap-4">
      <Input
        name="companyName"
        label="公司名"
        placeholder="例:某某科技有限公司"
        required
      />
      <Input
        name="contactName"
        label="姓名"
        placeholder="怎么称呼你"
        required
      />
      <Input
        name="email"
        type="email"
        label="工作邮箱"
        placeholder="name@company.com"
        required
      />
      <div className="flex flex-col gap-4 sm:flex-row">
        <Input
          name="teamSize"
          label="团队规模"
          placeholder="例:10-50 人"
        />
        <Input
          name="scale"
          label="预期用量"
          placeholder="例:每月 5000 次 Agent 运行"
        />
      </div>
      <TextArea
        name="description"
        label="需求描述"
        placeholder="你们想用智一 AI 解决什么问题?当前用什么工具?"
        rows={5}
        required
      />

      {state?.error && (
        <p className="text-error bg-error-tint border-error-tint rounded-control font-zh text-caption border p-3">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="border-success-tint bg-success-tint text-success rounded-control font-zh text-caption border p-3">
          {state.ok}
        </p>
      )}

      <div>
        <Button type="submit" variant="primary" size="lg">
          提交询价
        </Button>
      </div>
    </form>
  );
}
