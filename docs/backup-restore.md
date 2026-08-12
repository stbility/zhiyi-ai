# 备份与回滚(阶段 8,2026-08-12)

> 诚实边界:数据库备份是 **Supabase 平台能力**(Hobby 每天自动备份、Pro 含 7 天 PITR),
> 代码仓库回滚是 **git + 迁移机制**。本文档写清两边的真实步骤,不假装产品里有
> 「一键备份」按钮 —— 那不存在,也不该造一个假的。

## 1. 数据库备份(Supabase 平台)

| 计划 | 备份能力 |
|---|---|
| Hobby(免费) | 每天自动备份,保留 7 天,可下载/恢复 |
| Pro($25/月) | 每天备份 + **PITR(时间点恢复,7 天窗口)** |

**操作步骤**(Dashboard):
1. 打开 [Supabase Dashboard](https://supabase.com/dashboard) → 项目
   `ullmdnbgtauupndwqqzd`(zhiyi-ai)
2. 左侧 **Database → Backups**
3. 看到每日备份列表;Hobby 手动触发「Create backup」,Pro 可用 PITR 选时间点
4. 恢复 = 「Restore」到同一项目(覆盖)或新项目(隔离验证)

**迁移文件即备份**:`supabase/migrations/*.sql` 是 schema 的完整可重放历史,
`prod-migrations` workflow 每次 push main 自动重放。schema 丢了可以整体重建
(`0001` 起顺序执行),数据靠平台备份。

## 2. 应用代码回滚

Vercel 部署即 git:回滚 = 部署旧 commit。

**操作步骤**:
1. Vercel Dashboard → 项目 zhiyi-ai → **Deployments** 标签
2. 找到上一个健康部署的 SHA(可对照 `/api/health` 与 `/status.json`)
3. 点右侧 **⋯ → Promote to Production**(旧版本重新部署为生产)
4. 验证:`/status.json` 的 `deployed_sha` 变回旧 SHA,`/api/health` 200

## 3. 迁移回滚(谨慎)

**已应用的迁移不可修改**(0033/0034 特例已定案)—— 迁移是追加式历史。
「回滚一个迁移」的正确姿势是**写一个新的反向迁移**(编号递增),不是改旧文件:

```sql
-- 0057_rollback_xxx.sql(示例:回滚某张表)
drop table if exists public.xxx;
```

流程:写反向迁移 → PR → CI(迁移重放会验证可执行)→ 合入 main →
`prod-migrations` workflow 自动应用。

## 4. 灾难恢复演练(每季度)

1. 下载最新备份(Backups 页)
2. 在**新项目**恢复(不动生产)
3. 用 `supabase/migrations` 从零重放验证 schema 一致
4. 验证 `/api/health` 指向新项目时全绿
5. 记录耗时与问题到本文件末尾

---
最近一次演练:未执行(2026-08-12 首次编写本指南)。
