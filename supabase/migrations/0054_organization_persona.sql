-- 0054_organization_persona.sql
-- 品牌人格层(P3):组织级自定义人格。
--
-- 【背景】persona.ts 的 buildAgentSystemPrompt() 原本只接受固定规则块,
-- 所有组织共享同一套人格。P3 让组织配置自己的品牌人格(语气、品牌名、
-- 专属指令),注入智能体系统提示词。
--
-- 【实现】organizations 表加 persona 列(可空)。空 = 用默认人格。
-- RLS 沿用 organizations 既有策略:成员可读;owner/admin 可改(见
-- 0001 的 organizations_update_owner 策略)。这里只加列,不新建策略。
--
-- 迁移必须是纯 SQL(plpgsql assert 会红 CI)。

alter table public.organizations
  add column if not exists persona text;

-- 写入校验:长度上限 2000 字,超出会报错(如实暴露配置错误)
alter table public.organizations
  add constraint organizations_persona_length
  check (persona is null or char_length(persona) <= 2000);
