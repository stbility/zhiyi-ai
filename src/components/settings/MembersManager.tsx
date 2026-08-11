"use client";

import { useActionState, useState } from "react";

import { Badge } from "@/components/primitives/Badge";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Select } from "@/components/primitives/Select";
import { cn } from "@/lib/cn";
import {
  inviteMember,
  removeMember,
  updateMemberRole,
  type MemberActionResult,
} from "@/app/(app)/settings/members/actions";

export interface MemberRow {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly isSelf: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  member: "成员",
  viewer: "只读",
};

/**
 * 成员管理面板(阶段 2,2026-08-11)。
 *
 * 列表 + 邀请表单。owner/admin 可管理;RLS 已在数据库层保证权限,
 * 前端按钮对非管理员隐藏是体验层,不是安全边界。
 *
 * 真实数据原则:只展示库里真实存在的成员,空列表如实显示。
 */
export function MembersManager({
  organizationId,
  members,
}: {
  organizationId: string;
  currentUserId: string;
  members: readonly MemberRow[];
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [inviteState, inviteAction] = useActionState<
    MemberActionResult,
    FormData
  >(inviteMember, {});

  const canManage = members.some(
    (m) => m.isSelf && (m.role === "owner" || m.role === "admin"),
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-fg text-h2 font-zh font-semibold">成员管理</h2>
        <p className="text-fg-secondary font-zh text-caption mt-1">
          组织成员与角色。所有者和管理员可邀请成员、修改角色、移除成员。
        </p>
      </div>

      {/* 邀请表单(仅 owner/admin) */}
      {canManage && (
        <form
          action={inviteAction}
          className="border-border-default bg-surface-2 flex flex-col gap-3 rounded-panel border p-5"
        >
          <h3 className="text-fg text-h3 font-zh font-semibold">邀请成员</h3>
          <input type="hidden" name="organizationId" value={organizationId} />
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <Input
              name="email"
              type="email"
              label="邮箱"
              value={email}
              onChange={setEmail}
              placeholder="member@example.com"
              className="flex-1"
            />
            <Select
              name="role"
              value={role}
              onChange={(v) => setRole(v as "member" | "admin")}
              options={[
                { value: "member", label: "成员" },
                { value: "admin", label: "管理员" },
              ]}
              aria-label="角色"
              className="md:w-36"
            />
            <Button type="submit" variant="primary" size="md" disabled={!email}>
              邀请
            </Button>
          </div>
          <p className="text-fg-tertiary font-zh text-caption">
            被邀请者需先注册智一 AI。当前未接入邮件服务,邀请后对方登录即可看到组织。
          </p>
          {inviteState.error && (
            <p className="text-danger font-zh text-caption">{inviteState.error}</p>
          )}
          {inviteState.ok && (
            <p className="text-success font-zh text-caption">{inviteState.ok}</p>
          )}
        </form>
      )}

      {/* 成员列表 */}
      <div className="border-border-default bg-surface-2 overflow-hidden rounded-panel border">
        {members.length === 0 ? (
          <p className="text-fg-secondary font-zh text-caption p-6 text-center">
            组织暂无成员。
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-border-default text-fg-tertiary font-zh border-b text-caption">
                <th className="px-4 py-3 font-medium">成员</th>
                <th className="px-4 py-3 font-medium">角色</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRowView
                  key={m.id}
                  member={m}
                  canManage={canManage}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MemberRowView({
  member,
  canManage,
}: {
  member: MemberRow;
  canManage: boolean;
}) {
  const isOwner = member.role === "owner";
  const [rowState, setRowState] = useState<MemberActionResult>({});

  async function onRoleChange(nextRole: "member" | "admin") {
    const out = await updateMemberRole(member.id, nextRole);
    setRowState(out);
  }

  async function onRemove() {
    const out = await removeMember(member.id);
    setRowState(out);
  }

  return (
    <tr className="border-border-default hover:bg-surface-3 border-b last:border-b-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-fg font-zh font-medium">
            {member.displayName || member.email || "未命名用户"}
          </span>
          {member.isSelf && (
            <Badge tone="info">我</Badge>
          )}
        </div>
        {member.email && (
          <p className="text-fg-tertiary font-zh text-caption">{member.email}</p>
        )}
      </td>
      <td className="px-4 py-3">
        <Badge
          tone={
            isOwner
              ? "brand"
              : member.role === "admin"
                ? "info"
                : "neutral"
          }
        >
          {ROLE_LABEL[member.role] ?? member.role}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <Badge tone={member.status === "active" ? "success" : "warning"}>
          {member.status === "active" ? "已激活" : member.status}
        </Badge>
      </td>
      <td className="px-4 py-3">
        {canManage && !isOwner && !member.isSelf ? (
          <div className="flex items-center gap-2">
            <Select
              value={member.role === "admin" ? "admin" : "member"}
              onChange={(v) => void onRoleChange(v as "member" | "admin")}
              options={[
                { value: "member", label: "设为成员" },
                { value: "admin", label: "设为管理员" },
              ]}
              className="w-36"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void onRemove()}
            >
              移除
            </Button>
          </div>
        ) : (
          <span className="text-fg-tertiary font-zh text-caption">
            {isOwner ? "所有者" : ""}
          </span>
        )}
        {rowState.error && (
          <p className={cn("text-danger font-zh text-caption mt-1")}>
            {rowState.error}
          </p>
        )}
        {rowState.ok && (
          <p className={cn("text-success font-zh text-caption mt-1")}>
            {rowState.ok}
          </p>
        )}
      </td>
    </tr>
  );
}
