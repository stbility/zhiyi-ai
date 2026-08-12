# 迁移清单

仓库文件 ↔ 生产库账本(`supabase_migrations.schema_migrations`)的对应关系。

## 迁移纪律(2026-08-10 清理批次约定)

1. **攒批,不逐条**:同类小修复(Advisor 告警、索引、策略)攒成一批再出迁移,
   不再一条一 PR —— 48 条迁移里修复多于功能,审查负担失衡。
2. **快照自动同步**:改迁移后跑
   `bash scripts/check-migrations.sh --sync`(真实 PostgreSQL 重放 +
   自动重算 expected-policies/indexes),**人审 diff 确认预期**后提交;
   不要手改快照。CI 的「真实 PostgreSQL 迁移重放」仍是硬门禁。
3. **一条迁移一个主题**;契约(快照/MANIFEST)与迁移同 PR;代码改动不进迁移 PR。
4. **只读语义等价**:性能/告警修复必须保持策略名、角色、行级语义不变
   (如 0048 的 (select auth.uid()) 包装)。

## 为什么需要这份清单

整套迁移是**从生产库反解出来的**,不是先写文件再应用。于是仓库编号与生产
账本之间没有任何强制对应关系,两个方向的漂移都发生过:

- **生产有、仓库没有**:`merge_overlapping_policies_and_fk_indexes`
  (编号从 0011 直接跳到 0013)。`git log --all` 全历史搜不到它 ——
  **不是合并、不是撤回,是直接在生产上执行、从未写进仓库**。
  后果:从零重建的库缺 9 条策略、少一个外键索引,灾难恢复这条路是断的。
  已于 2026-08-05 依据生产库的真实定义补回为 `0012`。
- **仓库有、生产没有**:`0005_restore_auth_service_grants.sql`
  在生产账本里没有对应记录(见下表备注)。

这份清单把这层对应关系**写进仓库**。在此之前它只存在于生产库里,谁都验证不了。

## 对应表

| 仓库文件 | 生产账本 version | 生产账本 name |
|---|---|---|
| `0001_identity_and_orgs.sql` | 20260727150136 | identity_and_orgs |
| `0002_restrict_function_execute_grants.sql` | 20260727150511 | restrict_function_execute_grants |
| `0003_fix_bootstrap_deadlocks_and_audit_trigger.sql` | 20260728083201<br>20260728083250<br>20260728083342 | allow_creator_to_read_own_organization<br>allow_creator_bootstrap_first_membership<br>audit_organization_create_via_trigger |
| `0004_ai_providers.sql` | 20260728091025 | ai_providers |
| `0005_restore_auth_service_grants.sql` | — | **账本里没有**(见备注 A) |
| `0006_conversations_and_messages.sql` | 20260728113707 | conversations_and_messages |
| `0007_model_chat_capability.sql` | 20260728151616 | ai_models_chat_capability |
| `0008_move_security_definer_helpers_to_private.sql` | 20260729020012 | move_security_definer_helpers_to_private_schema |
| `0009_model_last_error_and_keep_models.sql` | 20260729090816 | model_last_error_and_keep_kimi |
| `0010_per_model_exclusions.sql` | 20260729094120 | per_model_exclusions |
| `0011_db_performance_and_rate_limit.sql` | 20260729114256 | rls_initplan_and_missing_indexes |
| `0012_merge_overlapping_policies_and_fk_indexes.sql` | 20260729114349 | merge_overlapping_policies_and_fk_indexes(**补回**) |
| `0013_chat_rate_limit.sql` | 20260729114458 | chat_rate_limit |
| `0014_rate_limit_function_grants.sql` | 20260729114621 | rate_limit_function_callable_by_service_role |
| `0015_conversation_attachments.sql` | 20260729120345 | conversation_attachments |
| `0016_integrations.sql` | 20260729125046 | integrations |
| `0017_workspaces.sql` | 20260729163509 | workspaces_and_files |
| `0018_restrict_cipher_columns.sql` | 20260802123125<br>20260802123238 | restrict_cipher_columns<br>restrict_cipher_columns_properly(见备注 B) |
| `0019_git_installations.sql` | 20260802142930 | git_installations |
| `0020_message_feedback.sql` | 20260803095312 | message_feedback |
| `0021_model_verification_state.sql` | 20260803134230 | model_verification_state |
| `0022_mcp_access_tokens.sql` | 20260803144924 | mcp_access_tokens |
| `0023_conversation_channel.sql` | 20260803203718 | conversation_channel |
| `0024_supports_tools_tristate.sql` | 20260803214004 | supports_tools_tristate |
| `0025_git_installation_credential_error.sql` | 20260804170117 | git_installation_credential_error |
| `0026_platform_models.sql` | 20260804212457 | platform_models |
| `0027_agent_runs_and_steps.sql` | 20260805… | agent_runs_and_steps |
| `0028_memories.sql` | 20260807… | memories |
| `0029_agent_steps_truncation_facts.sql` | 20260805… | agent_steps_truncation_facts |
| `0030_mcp_servers.sql` | 20260807… | mcp_servers |
| `0031_skills.sql` | 20260807… | skills, skill_files |
| `0032_alert_cleanup_fk_indexes.sql` | 20260807… | alert_cleanup_fk_indexes |
| `0033_stripe_customers_and_subscriptions.sql` | 20260807… | stripe_customers, subscriptions |
| `0034_entitlements.sql` | 20260807… | entitlements, get_entitlements |
| `0035_usage_metering.sql` | 20260807… | usage_metering, bump_usage, get_monthly_usage |
| `0036_workflows.sql` | 0036 | workflows, workflow_runs |
| `0037_entitlements_quota_alignment.sql` | 0037 | entitlements(配额 500/5000,见备注 C) |
| `0038_knowledge_files.sql` | 0038 | knowledge_files |
| `0039_eval_runs.sql` | 0039 | eval_runs, eval_run_cases |
| `0040_memory_embeddings.sql` | 0040 | pgvector 扩展 + memories.embedding + search_memories |
| `0041_eval_cases.sql` | 0041 | eval_cases(反馈飞轮消费端) |
| `0042_skills_member_editable.sql` | 0042 | skills 写策略 admin → 组织成员 |
| `0043_messages_run_id.sql` | 0043 | messages.run_id(续跑跨刷新) |
| `0044_ledger_baseline_rows.sql` | 0044 | 账本基线补记:0001-0027 以 4 位前缀行入账(详见备注 C) |
| `0045_mcp_execution_log.sql` | 0045 | MCP 执行日志:Hermes 执行状态回传(评审建议第 1 项) |
| `0046_supabase_advisors_security.sql` | 0046 | Security Advisor 8 条修复:vector → extensions schema;6 个 SECURITY DEFINER → INVOKER;usage_metering 写策略(详见备注 D) |
| `0047_rate_limits_explicit_lockdown.sql` | 0047 | rate_limits 显式封锁策略(RLS 无策略 INFO 修复,详见备注 E) |
| `0048_rls_auth_initplan.sql` | 0048 | Performance Advisor:10 条策略 auth.uid() → (select auth.uid()) InitPlan 化(详见备注 F) |
| `0049_clear_overlapping_policies.sql` | 0049 | Performance「多项宽松政策」11 条告警根治:清除 0012 生产漂移残留的 8 条旧策略(有效权限不变,详见备注 G) |
| `0050_index_hygiene.sql` | 0050 | Performance 信息建议前 10 条:补 6 条真缺外键索引(feedback_id/created_by/token_id/user_id/message_id)+ 删 4 条零查询路径的防御性索引(详见备注 H) |
| `0051_restore_fk_column_indexes.sql` | 0051 | 恢复 0050 误删的 4 条 **FK 列**索引(0001 未索引外键 vs 0005 未使用索引冲突,FK 列必须保索引,详见备注 I) |
| `0052_entitlements_five_tier_and_grants.sql` | 0052 | 五档定价落地:entitlements/subscriptions 的 plan_id CHECK 3 档→5 档 + 五档默认权益 upsert + 计费 RPC EXECUTE 授权重建(详见备注 J) |
| `0053_platform_models_refresh.sql` | 0053 | 平台免费档模型池刷新:下线 EOL 的 deepseek-v4-flash/pro(410 Gone),保留 glm-5.2(用户点名长期免费),加入实测快的 minimax-m3 / gpt-oss-20b(详见备注 K) |
| `0054_organization_persona.sql` | 待应用 | 品牌人格层(P3):organizations 表加 persona 列(可空,≤2000 字)。RLS 沿用组织既有策略(成员可读/admin 可改) |
| `0055_entitlements_expand_features.sql` | 待应用 | 权益矩阵扩展:新增 concurrent_tasks / history_days / knowledge_capacity / mcp_servers 四类 feature,五档数值对齐 plans.ts 营销承诺 |
| `0056_system_logs.sql` | 待应用 | 结构化日志(阶段 8):system_logs 表 + level 分级 + admin 读 RLS;关键事件(工作流/智能体/Worker)排查留痕,系统级事件不暴露前端 |
| `0057_system_logs_policy_harden.sql` | 待应用 | system_logs 写入策略收紧:with check(true) → is_org_member(修复 Supabase Advisor 告警) |

### 备注 L：0036-0053 已应用(2026-08-11 实证)

0036-0053 由 prod-migrate.sh 以 **4 位前缀行**入账(version='0036' 等,name=文件名)。
实证:prod-migrations workflow 日志(dbe2bc77, 2026-08-11)「账本前缀行 53 条,待应用 0 个,
生产库已是最新」+ 权益种子 10 行(五档落地)。此前标「待应用」是账本未随交付同步,
**判定生产迁移状态以 prod-migrations workflow 日志为准,不以此表为准**。
另:0052 曾出现重复条目(撞号残留),已清理为单条。


### 备注 D：Security Advisor 修复(2026-08-10)

8 条告警逐条对应:
- **[1] extension_in_public_vector** —— 0040 建 vector 扩展未限定 schema,落在 public。
  0046 执行 `alter extension vector set schema extensions`(Supabase 官方约定:
  扩展装 extensions schema,不污染 public;官方文档
  https://supabase.com/docs/guides/database/extensions)。
  连带:search_memories 函数体显式 `OPERATOR(public.<=>)` 随扩展移动失效,
  0046 重建为 `OPERATOR(extensions.<=>)` + `extensions.vector(1536)` 类型限定。
- **[2-7] 6 个 SECURITY DEFINER 可被 authenticated 执行**(bump_usage /
  get_entitlements / get_monthly_usage / recall_memories / search_memories /
  touch_memory)——函数体全部自限定 auth.uid()(bump_usage 抛「无权操作其他用户
  的用量」、recall 成员绑定、touch 所有权、get_entitlements 只认调用者订阅),
  无跨用户漏洞;但按官方建议(撤销 EXECUTE 或改 SECURITY INVOKER),这些函数
  由服务端以用户会话调用(createSupabaseServerClient),撤销会破坏功能 →
  改为 SECURITY INVOKER + 依赖表 RLS(等价的行级约束)。
  bump_usage 是唯一写函数(upsert usage_metering),INVOKER 后补
  usage_metering_insert_own / usage_metering_update_own 行级策略(仅自己)。
- **[8] auth_leaked_password_protection** —— Dashboard 开关,非迁移:
  Supabase Dashboard → 项目 → Authentication → Security →
  「Leaked password protection」打开(密码过 HIBP 泄露库检查)。

### 备注 E：rate_limits 显式封锁(2026-08-10)

Security Advisor(INFO)「RLS 未启用政策:public.rate_limits」——
rate_limits 是**服务端专用表**:唯一访问路径是 security definer 的
`public.bump_rate_limit`(0013),客户端(anon/authenticated)从不直接读写;
RLS 开启 + 零策略 = 全角色被 RLS 挡死(最严姿态),Advisor 要求确认意图。
0047 按官方 RLS restrictive policy 做法,加显式拒绝策略
`rate_limits_no_direct_access`(for all to anon, authenticated using(false)),
意图自文档化(server-only)且清掉「无策略」发现。DEFINER 函数以
owner(postgres)身份执行,不受 RLS 影响,bump_rate_limit 读写照常。

### 备注 F：RLS InitPlan 优化(2026-08-10)

Performance Advisor「Auth RLS 初始化计划」——策略表达式直接调 `auth.uid()` 时
PostgreSQL 对**每一行**求值一次;包成 `(select auth.uid())` 后变成 InitPlan,
整条查询只算一次(官方推荐写法,数据量越大差距越大)。
0011 当年只补了缺失外键索引,策略重写留成注释未做;0012 之后的新策略全部
已是 (select auth.uid()) 写法,早期 0001/0003/0006/0008 的 10 条裸调用:
profiles_select_self / profiles_select_org_peers / profiles_insert_self /
profiles_update_self / organizations_insert_self / organizations_select_creator /
memberships_insert_creator_bootstrap / conversations_own(0008 private 版)/
messages_own。0048 全部改为等价 (select auth.uid()) 写法(策略名/角色/语义不变,
契约快照仅列名,无需变更)。
**生产漂移实证**:0012 已 drop 旧策略(profiles_select_self / org_peers /
organizations_select_creator / memberships_insert_creator_bootstrap)并合并为
profiles_select_visible 等,但生产库仍存在这些旧策略(Performance Advisor 在
production 实测可见)——仓库重放 ≠ 生产实况。因此 0048 用 **DO 块 +
pg_policies 存在性检查**:策略存在才改写,全新重放库跳过,生产库修复,
两种状态幂等安全。教训:SQL 迁移的唯一真实门禁是 CI 的
「真实 PostgreSQL 迁移重放」(本地 migration-final-state 只对快照列名,
不执行 SQL,曾漏放 ALTER POLICY 指向不存在策略的错误)。

### 备注 G：Performance「多项宽松政策」11 条告警(2026-08-10)

Advisor 报 ai_models/ai_providers × 4 动作 + memberships INSERT + organizations
SELECT + profiles SELECT 共 11 条「同一 role+action 多条宽松策略」。根因 =
0012 生产漂移(0012 的 8 条 drop 在生产未生效,旧策略与合并后策略并存;
0048 头注释已实证)。修复 = 0049 补删 8 条旧策略(drop if exists,重放库无
副作用),有效权限与 0012 合并后完全一致:ai_*_write_admin(FOR ALL)→
select_member 覆盖 admin(admin 是成员);profiles/organizations 旧 SELECT →
select_visible OR 覆盖;memberships insert_admin/bootstrap → insert_allowed
覆盖。删除后每动作仅剩 1 条 permissive 策略,Advisor 11 条清零。

### 备注 H：Performance 信息建议前 10 条(2026-08-10)

- **[1-6] 未索引外键 ×6**(eval_cases.feedback_id / knowledge_files.created_by /
  mcp_execution_log.token_id+user_id / memories.message_id / workflows.created_by):
  逐列核对表定义,PK/UNIQUE/组合索引均未覆盖(与 0049 翻车不同——0049 两列是
  PK 隐含索引,这里 6 列真缺)。0050 补 `<table>_<col>_idx`(列名去 _id 后缀,
  沿用仓库惯例)。反馈飞轮同步幂等查 `eval_cases where feedback_id` 直接受益。
- **[7-10] 未使用索引 ×4**(conversation_attachments_organization_idx /
  ai_providers_created_by_idx / audit_logs_actor_idx / organizations_created_by_idx):
  0011/0015 防御性预建,应用层零查询路径(attachments 全走 conversation_id 且
  RLS 只认 conversation;providers 按 org 查;audit_logs 无 actor 过滤;
  organizations 小表恒 seq scan)。非唯一约束(唯一索引删除会破坏约束,已核对),
  0050 删。**教训:预建索引要配查询路径,否则 Advisor 会因 idx_scan=0 报未使用。**

### 备注 I：0001 vs 0005 检查冲突,FK 列索引必须保留(2026-08-10)

0050 把 4 条「未使用」索引(ai_providers_created_by_idx /
organizations_created_by_idx / conversation_attachments_organization_idx /
audit_logs_actor_idx)当零查询路径删除 —— 但 4 列全部是外键
(created_by/created_by/organization_id/actor_id,references auth.users /
organizations)。生产实测:0050 交付后 Advisor 立刻新增 4 条「未索引外键」
(0001)告警(如 ai_providers_created_by_fkey)。根因:0001 强制 FK 列必须建
索引,0005 的「未使用」对 FK 列是伪建议 —— 两检查在零查询流量的 FK 列上
冲突,0001 是硬规则(join/cascade/RI 性能),0005 只应作用于非 FK 列索引。
0051 恢复 4 条。**规则:删索引前先查该列是否 FK(表定义 references 子句 /
pg_constraint);FK 列索引永不删。**

### 备注 J：五档定价落地(2026-08-11)

0034/0033 生产版 plan_id CHECK 只含 3 档(free/professional/enterprise),
0037 的 INSERT professional_plus/team 会违反约束 → 0036-0051 全部卡在
「待应用」,五档定价永远无法落地。0052 做三件事:

- **A. 约束放宽**:entitlements 与 subscriptions 的 plan_id CHECK 3 档→5 档
  (DO 块存在性检查,幂等;0037 已改同法放宽 entitlements,0052 兜底两者)。
- **B. 五档默认权益 upsert**(on conflict do update,保留已有行):
  Free(1/100) / Professional(5/2000) / Professional+(10/4000) /
  Team(null/10000) / Enterprise(null/null)。与新版落地页 plans.ts 完全一致。
- **C. 计费 RPC 授权重建**:get_entitlements / bump_usage / get_monthly_usage
  的 EXECUTE revoke+grant(0046 改 security invoker 后的完整性兜底,幂等)。

配套(2026-08-11):
- 0036 编号撞车修复:删除 0036_stripe_webhook_subscription_ops.sql
  (upsert_stripe_subscription 全仓库零调用方,死代码;字母序排在 workflows
  前导致 prod-migrate 只应用它、0036_workflows 永不应用)。
- 0037 配额对齐修正:按 2026-08-11 五档定价重写(pro=2000/ent=不限,
  非旧四档 pro=500/ent=5000);INSERT 前先放宽 entitlements 约束。
- stripe.ts resolvePriceIdForPlan 同步化;turn-quota.ts 文案对齐新定价。

⚠️ 生产现状核对(2026-08-11 探测):0033/0034/0035 已应用,0036-0051 待应用;
Vercel env 的 STRIPE_PRICE_* 4 个全未配置(status.json
stripe_prices_configured=0)→ checkout 主路径 503 → 降级 Payment Link。


### 备注 A：0005 在账本里没有记录(已由 0044 补记)

`0005_restore_auth_service_grants.sql` 恢复的是 `supabase_auth_admin` 对
`public` schema 的授权。生产账本里没有同名条目 —— 最可能的解释是当初
直接执行、没走迁移通道。它是幂等的(纯 GRANT),重放不会出问题;
CI 的真实重放已经覆盖它。0044 已把 0005 连同基线 0001-0027 一并补记入账本。

### 备注 B：0018 对应两条账本记录

第一次的 `restrict_cipher_columns` **没做对** —— 只写了列级 `REVOKE`,
而列级 revoke 撤不掉表级授权,语句全部成功、权限一点没变。
`restrict_cipher_columns_properly` 是补正:先收回表级 SELECT,
再按列白名单重新授予。

仓库里的 `0018` 是**补正后的版本**,所以单独重放它就能得到正确结果。
这也是为什么「语句执行成功」永远不等于「结果正确」——必须查结果。

> 编号说明:0036 已被工作流状态机(0036_workflows.sql)占用,本迁移顺延为 0037。

### 备注 C：0037 权益配额对齐(Pro 500 / Ent 5000)

0034 定义 initial 配额时用的是早期定价草案(pro=2000 / ent 不限),
而落地页定价区 2026-08-08 已按「每月 500 / 5,000 次 Agent 额度」对外宣传。
0037 用增量 UPDATE 把判断层收敛到页面承诺值,不改 0034(它已进生产账本)。
幂等条件 `WHERE quota = 旧值` 保证重放安全。

## 维护规则

1. **新迁移一律先写文件再应用**,不要在控制台或通过 MCP 直接改生产库。
   直接改的东西不会进仓库,而没进仓库的东西灾难恢复时就没有。
2. 应用之后把 version / name 补进上表。
3. 改动了策略或索引,同步更新 `supabase/test/expected-policies.txt`
   与 `expected-indexes.txt` —— CI 会拿它们和真实重放的结果 diff。
4. 编号必须连续。断号是「漏了整条迁移」最直接的信号,
   `tests/app/migration-final-state.test.ts` 会挡住它。

### 备注 C：0044 账本基线补记

0001-0027 是交付自动化接管前的基线:生产库对象全部存在(2026-08-08
三层审计实证:仓库文件完整、生产库表/列/函数可探测、账本时间戳行在),
但账本里只有原始时间戳行(20260727…),没有自动化写的 4 位前缀行 ——
任何按「前缀行=已应用」口径读账本的审计都会误报「0001-0027 丢失未回补」。
0044 以 4 位前缀行把基线补记入账本(幂等),配套
`scripts/prod-migrate.sh` 的清理逻辑改为只删「无对应迁移文件」的行,
避免每次交付把补记冲掉。

### 备注 K：平台免费档模型池刷新(2026-08-11)

0026 种子的 3 个免费模型在 NVIDIA integrate API 生产实测:
- `deepseek-ai/deepseek-v4-flash` / `deepseek-ai/deepseek-v4-pro`:
  HTTP 410 Gone,「reached its end of life on 2026-08-07」—— 已下线。
  智能体/AI助手页选到它们必失败。
- `z-ai/glm-5.2`:可用,但首 token 70-120 秒(NVIDIA 容量塌陷),
  单步 45s 超时、整轮 300s 上限全撞,产物随中断丢失。

0052 下线两个 EOL 模型(enabled=false 留痕不删行)、保留 glm-5.2
(用户点名长期免费)、加入生产实测快的 minimax-m3(≈4s)与 gpt-oss-20b(即时),
让免费档降级链真正可用。密钥仍走 PLATFORM_NVIDIA_API_KEY 环境变量,
未配置时界面如实显示「未配置」。