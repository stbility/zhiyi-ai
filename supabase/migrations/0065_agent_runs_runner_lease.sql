-- 0065 Agent Runner lease 列(阶段 B:Runner 骨架数据基础)
--
-- 【要解决的真实问题】
-- 长时 Agent 执行需要持久 Runner 脱离 Vercel Function 300s 生命周期。
-- Runner 通过 PostgreSQL 队列(FOR UPDATE SKIP LOCKED)领取 agent_runs,
-- 需要 lease + generation fencing 防双执行(冻结架构 Phase 2.2)。
--
-- 【纯新增】不改任何现有列/约束/语义:
--   claimed_by          Runner 实例标识(text,非用户 —— Runner 实例 id)
--   claimed_at          领取时间
--   lease_expires_at    租约到期时间(过期可被接管)
--   lease_generation    单调递增 fencing token(每次接管 +1,旧代际写入被拒)
--
-- 【语义】
--   · queued 任务:claimed_by IS NULL → 可领取
--   · 租约过期:lease_expires_at < now() → 可被接管(其他 Runner 或恢复)
--   · 每次 claim/takeover:lease_generation = lease_generation + 1
--   · 所有关键写操作(agent_steps/checkpoint/finish)必须携带当前 generation
--
-- 【幂等】add column if not exists + create index if not exists,重放安全。

begin;

alter table public.agent_runs
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists lease_generation integer not null default 0;

-- Runner 领取扫描索引:queued 任务 + 租约过期任务(含运行中可被接管的)
create index if not exists agent_runs_claim_idx
  on public.agent_runs (status, lease_expires_at)
  where status in ('queued', 'interrupted', 'running', 'waiting_model', 'running_tool');

commit;
