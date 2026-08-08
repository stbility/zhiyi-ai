-- 0042 技能库:写操作从 admin 放开到组织成员
--
-- 「可被非工程师编辑的工作流」是技能库与聊天框的分界 —— 技能是
-- 组织共享资产,成员编辑是产品意图,不是安全漏洞。删除同理
-- (成员可删自己组织的技能;组织归属仍是硬约束)。
--
-- 与 0031 的差异:0031 只允许 owner/admin 写入;0042 改为
-- 组织成员写入(insert 校验 created_by,update/delete 校验组织成员),
-- 保留 select_member 不动。

drop policy if exists skills_insert_admin on public.skills;
drop policy if exists skills_update_admin on public.skills;
drop policy if exists skills_delete_admin on public.skills;

create policy skills_insert_member on public.skills
  for insert to authenticated
  with check (
    private.is_org_member(organization_id)
    and created_by = (select auth.uid())
  );

create policy skills_update_member on public.skills
  for update to authenticated
  using (private.is_org_member(organization_id))
  with check (private.is_org_member(organization_id));

create policy skills_delete_member on public.skills
  for delete to authenticated
  using (private.is_org_member(organization_id));
