-- 0018 密文列不再对浏览器开放
--
-- 问题:ai_providers_select_member 与 integrations_select_member 授予任意
-- 组织成员 SELECT 全部列,其中包含 api_key_cipher / credential_cipher。
-- 而 PostgREST 是对外暴露的 —— 任何拿到自己会话令牌的成员(哪怕只是
-- viewer)都可以直接
--   GET /rest/v1/ai_providers?select=api_key_cipher
-- 把全部密文拉走。
--
-- 密文本身还需要 ENCRYPTION_KEY 才能解开,而那把钥匙只在服务端环境变量里,
-- 不和数据库放在一起。所以这不是直接失陷,但「钥匙与密文分离」这条防线
-- 本来就该配合「密文也不随便给」才成立 —— 少一层就是少一层。
--
-- 收紧方式选的是**列级权限**而不是改 RLS 策略:
-- RLS 是行级的,表达不了「这一行能读、但这一列不能读」。
-- 列级 REVOKE 恰好就是为这种情况准备的。
--
-- 收紧之后服务端怎么读?走 service_role(它绕过列级权限),
-- 并且必须先用**用户身份**确认此人有权访问该服务商,再用管理客户端
-- 仅取那一行的密文。见 src/lib/ai/credentials.ts。
--
-- 为什么不是「只给 owner/admin 读」:普通成员也要能对话,而对话必须
-- 用到密钥。按角色收紧会直接让成员用不了产品。

-- 关键:**列级 REVOKE 撤不掉表级授权**。
-- 这两个角色持有 GRANT SELECT ON TABLE,只写
--   revoke select (api_key_cipher) ... from authenticated
-- 语句会成功、但完全不起作用 —— 表级授权仍然覆盖全部列。
-- 第一次就是这么写的,应用成功后一查权限,authenticated 照样能读。
-- 必须先收回表级 SELECT,再按列白名单重新授予。
revoke select on public.ai_providers from authenticated, anon;
revoke select on public.integrations from authenticated, anon;

-- 掩码列保持可读 —— 界面要显示「••••••••8c37」,那是脱敏后的展示值,
-- 不构成泄露,而且没有它用户无法分辨自己填的是哪一把密钥。
grant select (
  id, organization_id, kind, display_name, base_url, api_key_masked,
  enabled, last_tested_at, last_test_ok, last_test_error,
  created_by, created_at, updated_at
) on public.ai_providers to authenticated;

grant select (
  id, organization_id, kind, display_name, credential_masked,
  enabled, last_tested_at, last_test_ok, last_test_error,
  created_by, created_at, updated_at
) on public.integrations to authenticated;

-- 写入仍需带上密文列(用户填新密钥时要写进去),所以保留 INSERT/UPDATE;
-- 限制到 owner/admin 由 RLS 策略负责,那是行级的事。

-- 验证方式(改完必须实测,不能只看语句成功):
--   select grantee from information_schema.column_privileges
--   where column_name = 'api_key_cipher' and privilege_type = 'SELECT';
-- 结果应当只剩 postgres 与 service_role。
