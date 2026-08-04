-- 安装是 GitHub 侧的既成事实,不该因为我们这边凭据坏掉就被丢弃。
--
-- 用户实测遇到的情况:他在 GitHub 上把应用装好了(安装编号 151228033
-- 是真实存在的),但本站拿这个编号去换访问令牌时被 GitHub 拒绝
-- (401 A JSON web token could not be decoded —— 私钥与该 App 不匹配)。
--
-- 此前的处理是:换令牌失败就**什么都不写**,直接带着报错返回。
-- 后果是卡片一直显示「未连接」,而用户看着 GitHub 上明明装好了的应用,
-- 只能得出「这个功能是坏的」这个结论 —— 他没说错,但原因不是没装上。
--
-- 这两件事必须分开记:
--   installation_id  GitHub 说的,客观事实,装上了就是装上了
--   credential_error 我们这边换令牌失败的原因,是**我们的**问题
--
-- 分开之后:
--   · 安装记录不再丢失,凭据修好后不需要重装,也不需要重新走授权
--   · 卡片能如实说「已安装,但本站凭据有问题」,而不是含糊的「未连接」
--   · Git 工具仍然不可用(换不到令牌就调不了 API),这一点不能含糊
alter table public.git_installations
  add column if not exists credential_error text;

comment on column public.git_installations.credential_error is
  '换取安装令牌失败的原因。非空表示:应用已在 GitHub 上安装成功,但本站的 App 凭据(私钥/Client ID)有问题,暂时调不了仓库 API。为 null 表示凭据可用。';
