import type { Metadata } from "next";

import { CreateOrganizationForm } from "@/components/app/CreateOrganizationForm";
import { Icon } from "@/components/icons/Icon";
import { getCurrentOrganization, getProfile, getRecentAudit } from "@/lib/db/queries";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "今日 · 智一 AI" };

// 用户数据不可缓存,每次请求实时读取
export const dynamic = "force-dynamic";

function formatDate(): string {
  const now = new Date();
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    now.getDay()
  ];
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekday}`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "凌晨好";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/**
 * 今日工作台。
 *
 * 当前只呈现数据库里真实存在的内容:账户、组织、审计记录。
 * 工作流、知识库、长期记忆的数据表尚未建立(Phase 4/5),
 * 因此这些板块如实标注「尚未交付」,而不是填充占位内容让页面显得饱满。
 */
export default async function TodayPage() {
  const [user, profile, org] = await Promise.all([
    getCurrentUser(),
    getProfile(),
    getCurrentOrganization(),
  ]);

  const audit = org ? await getRecentAudit(org.id, 5) : [];

  const name = profile?.displayName ?? user?.email?.split("@")[0] ?? "";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-8 md:py-10">
      <header>
        <p className="text-fg-tertiary text-caption font-mono">
          {formatDate()}
        </p>
        <h2 className="text-fg text-h2 font-zh mt-1 font-semibold">
          {greeting()}
          {name ? `,${name}` : ""}
        </h2>
      </header>

      {/* 组织 */}
      {org ? (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
          <h3 className="text-fg-tertiary text-label mb-3">当前组织</h3>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Icon name="shield" size={16} className="text-brand shrink-0" />
              <span className="text-fg text-body">{org.name}</span>
            </div>
            <span className="text-fg-tertiary text-label border-border-default rounded-tag border px-2 py-0.5">
              {org.role === "owner" ? "所有者" : org.role}
            </span>
          </div>
        </section>
      ) : (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
          <h3 className="text-fg text-body mb-1 font-medium">创建您的组织</h3>
          <p className="text-fg-secondary text-caption mb-4">
            工作流、知识库与记忆都归属于组织。创建后才能开始使用。
          </p>
          <CreateOrganizationForm />
        </section>
      )}

      {/* 审计记录 —— 真实数据,为空就说为空 */}
      {org && (
        <section className="bg-surface-2 border-border-default rounded-card font-zh border p-5">
          <h3 className="text-fg-tertiary text-label mb-3">最近操作记录</h3>
          {audit.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {audit.map((entry) => (
                <li
                  key={entry.id}
                  className="text-fg-secondary flex flex-wrap items-center justify-between gap-2 text-[13px]"
                >
                  <span>
                    {entry.action} · {entry.resourceType}
                  </span>
                  <span className="text-fg-tertiary text-label font-mono">
                    {new Date(entry.createdAt).toLocaleString("zh-CN")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-tertiary text-caption">暂无操作记录。</p>
          )}
        </section>
      )}

      {/* 未交付模块 —— 如实说明,不用占位数据充数 */}
      <section className="border-border-default rounded-card font-zh border border-dashed p-5">
        <h3 className="text-fg-tertiary text-label mb-2">尚未交付的模块</h3>
        <p className="text-fg-tertiary text-caption">
          AI 摘要、工作流、知识库与长期记忆的数据层尚未建立,因此这里不展示任何相关内容。产品不会用占位数据填充未完成的能力。
        </p>
      </section>
    </div>
  );
}
