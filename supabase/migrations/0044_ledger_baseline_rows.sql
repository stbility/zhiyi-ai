-- 0044 账本基线补记:0001-0027 全部记入生产迁移账本
--
-- 背景:生产迁移账本(supabase_migrations.schema_migrations)由交付自动化
-- 维护。自动化只给 > BASELINE(0027)的迁移写 4 位前缀行(如 '0028');
-- 0001-0027 是自动化接管前的基线,账本里只有原始时间戳行(20260727…),
-- 没有 4 位前缀行 —— 任何按「前缀行=已应用」口径读账本的审计,都会把
-- 0001-0027 误报为「丢失未回补」(2026-08-08 实测:0001/0018/0019/0022/0023
-- 被审计点名,但三层证据——仓库文件、生产库对象、账本时间戳行——全部存在)。
--
-- 本迁移把基线 0001-0027 以 4 位前缀行形式补记入账本,让账本视图完整:
-- 前缀行与仓库文件一一对应,审计按前缀行口径也能看到完整链。
-- 幂等:version 主键 + on conflict do nothing,重放安全。
--
-- 配套:scripts/prod-migrate.sh 的「清理误写前缀行」改为只删「无对应迁移
-- 文件」的行 —— 否则每次交付运行都会把这里补记的行再删掉。

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text,
  statements text[]
);

insert into supabase_migrations.schema_migrations (version, name) values
  ('0001', '0001_identity_and_orgs.sql'),
  ('0002', '0002_restrict_function_execute_grants.sql'),
  ('0003', '0003_fix_bootstrap_deadlocks_and_audit_trigger.sql'),
  ('0004', '0004_ai_providers.sql'),
  ('0005', '0005_restore_auth_service_grants.sql'),
  ('0006', '0006_conversations_and_messages.sql'),
  ('0007', '0007_model_chat_capability.sql'),
  ('0008', '0008_move_security_definer_helpers_to_private.sql'),
  ('0009', '0009_model_last_error_and_keep_models.sql'),
  ('0010', '0010_per_model_exclusions.sql'),
  ('0011', '0011_db_performance_and_rate_limit.sql'),
  ('0012', '0012_merge_overlapping_policies_and_fk_indexes.sql'),
  ('0013', '0013_chat_rate_limit.sql'),
  ('0014', '0014_rate_limit_function_grants.sql'),
  ('0015', '0015_conversation_attachments.sql'),
  ('0016', '0016_integrations.sql'),
  ('0017', '0017_workspaces.sql'),
  ('0018', '0018_restrict_cipher_columns.sql'),
  ('0019', '0019_git_installations.sql'),
  ('0020', '0020_message_feedback.sql'),
  ('0021', '0021_model_verification_state.sql'),
  ('0022', '0022_mcp_access_tokens.sql'),
  ('0023', '0023_conversation_channel.sql'),
  ('0024', '0024_supports_tools_tristate.sql'),
  ('0025', '0025_git_installation_credential_error.sql'),
  ('0026', '0026_platform_models.sql'),
  ('0027', '0027_agent_runs_and_steps.sql')
on conflict (version) do nothing;
