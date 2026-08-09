# 迁移清单

仓库文件 ↔ 生产库账本(`supabase_migrations.schema_migrations`)的对应关系。

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
| `0036_workflows.sql` | 待应用 | workflows, workflow_runs |
| `0037_entitlements_quota_alignment.sql` | 待应用 | entitlements(配额 500/5000,见备注 C) |
| `0038_knowledge_files.sql` | 待应用 | knowledge_files |
| `0039_eval_runs.sql` | 待应用 | eval_runs, eval_run_cases |
| `0040_memory_embeddings.sql` | 待应用 | pgvector 扩展 + memories.embedding + search_memories |
| `0041_eval_cases.sql` | 待应用 | eval_cases(反馈飞轮消费端) |
| `0042_skills_member_editable.sql` | 待应用 | skills 写策略 admin → 组织成员 |
| `0043_messages_run_id.sql` | 待应用 | messages.run_id(续跑跨刷新) |
| `0044_ledger_baseline_rows.sql` | 待应用 | 账本基线补记:0001-0027 以 4 位前缀行入账(详见备注 C) |

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