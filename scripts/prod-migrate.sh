#!/usr/bin/env bash
# =============================================================================
# 生产迁移自动交付(0001-0035 全链)
#
# 背景:0028-0035 此前是「写完文件就算交付」——仓库有文件,生产库从未应用,
#       也没有任何管道。本脚本把交付变成自动化:
#         - 首次运行自动探测生产库状态,补齐缺口(见下)
#         - 之后每次 main 推送(或手动触发)只应用账本缺失的迁移
#         - 每个迁移独立请求、失败即停、全部幂等可安全重跑
#
# 首次运行三种情形(自动判定,不需要人工参数):
#   1. 全新空库(public 无表)         → 全量应用 0001-0035
#   2. 已有库、无迁移账本(=当前生产) → 基线 0001-0027 入账(已实测验证),
#                                      再应用 0028-0035
#   3. 已有账本                        → 只应用账本缺失的版本
#
# 通道:Supabase Management API(database/query)。
#       只需要 access token,不需要数据库密码 —— token 存 GitHub secret。
#
# 环境变量:
#   SUPABASE_ACCESS_TOKEN  必填,Access Tokens(sbp_ 开头)
#   SUPABASE_PROJECT_REF   可选,默认 ullmdnbgtauupndwqqzd(生产项目)
#
# 本地试跑:SUPABASE_ACCESS_TOKEN=sbp_xxx bash scripts/prod-migrate.sh
# =============================================================================
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-ullmdnbgtauupndwqqzd}"
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
API="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"
MIG_DIR="$(cd "$(dirname "$0")/../supabase/migrations" && pwd)"

# 生产库实测基线(2026-08-08 anon 探测验证):0001-0027 已应用,0028-0035 缺失。
# 仅「已有库且无账本」时生效;空库自动走全量,无需改动。
BASELINE="0027"

if [ -z "$TOKEN" ]; then
  echo "❌ 缺少 SUPABASE_ACCESS_TOKEN" >&2
  exit 2
fi

json_body() { python3 -c "import json,sys; print(json.dumps({'query': sys.argv[1]}))" "$1"; }
api_raw() {
  curl -sS --max-time 180 -X POST "$API" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(json_body "$1")"
}
# 把 Management API 响应归一成「OK rows=N」/「ERR: msg」
verdict() {
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print('OK rows=' + str(len(d)) if isinstance(d, list) else 'ERR: ' + str(d.get('message') or d.get('error') or d.get('code') or d)[:300])
except Exception as e:
    print('ERR: 非 JSON 响应: ' + str(e))
"
}
# 从 API 响应里取第一行第一列的标量值(探测用)
scalar() {
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    if isinstance(d, list) and d:
        row = d[0]
        if row is None:
            print('')
        else:
            v = next(iter(row.values())) if isinstance(row, dict) else row[0]
            print('' if v is None else str(v))
except Exception:
    pass
"
}
# 单列表查询结果 → 空格分隔的值串(账本版本集合用)
scalar_list() {
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    if isinstance(d, list):
        print(' '.join(str(next(iter(r.values()))) for r in d if isinstance(r, dict)))
except Exception:
    pass
"
}

run_sql() {
  local desc="$1" sql="$2" v
  echo "--- $desc"
  v=$(api_raw "$sql" | verdict)
  echo "    $v"
  if [[ "$v" == ERR:* ]]; then
    echo "!! 失败于:$desc" >&2
    exit 1
  fi
}

# 本地迁移版本列表(文件名自然序;兼容 bash 3.2)
LOCAL_VERSIONS=($(ls "$MIG_DIR" | grep -E '^[0-9]{4}_.*\.sql$' | sed 's/_.*\.sql$//'))

echo "=============================================================="
echo "生产迁移自动交付  项目: $PROJECT_REF"
echo "本地迁移版本: ${LOCAL_VERSIONS[0]} .. ${LOCAL_VERSIONS[${#LOCAL_VERSIONS[@]}-1]}(${#LOCAL_VERSIONS[@]} 个)"
echo "=============================================================="

# 1. 探测生产库状态
echo "[1/4] 探测生产库状态"
LEDGER_SQL="select to_regclass('supabase_migrations.schema_migrations') as tbl;"
TBL_SQL="select count(*) as n from pg_tables where schemaname='public';"
L_RAW=$(api_raw "$LEDGER_SQL")
T_RAW=$(api_raw "$TBL_SQL")
echo "    账本表: $(echo "$L_RAW" | verdict)"
echo "    public 表数: $(echo "$T_RAW" | verdict)"

# fail-fast:鉴权/网络失败立刻退出,绝不能把 ERR 误判成「空库」去全量应用
if [[ "$L_RAW" != '['* ]]; then
  echo "!! 无法连接生产库(检查 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF):" >&2
  echo "   $(echo "$L_RAW" | verdict)" >&2
  exit 1
fi

ledger_exists=false
if echo "$L_RAW" | grep -q '"tbl":"supabase_migrations.schema_migrations"'; then
  ledger_exists=true
fi
count=$(echo "$T_RAW" | scalar)
count=${count:-0}

# 2. 计算要应用的版本
echo "[2/4] 计算缺失版本"
declare -a TO_APPLY=()
if $ledger_exists; then
  applied_set=$(api_raw "select version from supabase_migrations.schema_migrations;" | scalar_list)
  for v in "${LOCAL_VERSIONS[@]}"; do
    if ! echo " $applied_set " | grep -q " $v "; then
      TO_APPLY+=("$v")
    fi
  done
  echo "    账本已含 $(echo "$applied_set" | wc -w | tr -d ' ') 个,待应用 ${#TO_APPLY[@]} 个"
elif [ "$count" -eq 0 ]; then
  TO_APPLY=("${LOCAL_VERSIONS[@]}")
  echo "    空库判定 → 全量应用 ${#TO_APPLY[@]} 个迁移"
else
  echo "    已有库判定 → 核对基线(0001-0027 已应用,0028 缺失)"
  run_sql "基线核对:memories 表应不存在" \
    "select to_regclass('public.memories') is null as memories_missing;"
  run_sql "基线核对:agent_runs 应存在" \
    "select to_regclass('public.agent_runs') is not null as agent_runs_ok;"
  run_sql "基线核对:git_installations 应存在" \
    "select to_regclass('public.git_installations') is not null as git_ok;"
  for v in "${LOCAL_VERSIONS[@]}"; do
    if [[ "$v" > "$BASELINE" ]]; then
      TO_APPLY+=("$v")
    fi
  done
  echo "    待应用增量(> $BASELINE):${#TO_APPLY[@]} 个"
fi

if [ "${#TO_APPLY[@]}" -eq 0 ]; then
  echo "✅ 无缺失迁移,生产库已是最新。"
  exit 0
fi

# 3. 准备迁移账本
echo "[3/4] 准备迁移账本"
run_sql "创建账本表(如缺)" \
  "create schema if not exists supabase_migrations;
   create table if not exists supabase_migrations.schema_migrations (
     version text primary key,
     name text,
     statements text[]
   );"
if ! $ledger_exists && [ "$count" -gt 0 ]; then
  vals=""
  for v in "${LOCAL_VERSIONS[@]}"; do
    if [[ "$v" < "$BASELINE" || "$v" == "$BASELINE" ]]; then
      fname=$(ls "$MIG_DIR" | grep -E "^${v}_.*\.sql$" | head -1)
      [ -n "$vals" ] && vals="$vals,"
      vals="$vals('$v','$fname')"
    fi
  done
  run_sql "基线入账 0001-0027" \
    "insert into supabase_migrations.schema_migrations (version, name)
     select v.version, v.name from (values $vals) as v(version, name)
     on conflict (version) do nothing;"
fi

# 4. 按序应用
echo "[4/4] 应用 ${#TO_APPLY[@]} 个迁移"
for v in "${TO_APPLY[@]}"; do
  fname=$(ls "$MIG_DIR" | grep -E "^${v}_.*\.sql$" | head -1)
  [ -n "$fname" ] || { echo "!! 找不到 $v 对应的迁移文件" >&2; exit 1; }
  echo "=== 应用 $fname"
  run_sql "$fname" "$(cat "$MIG_DIR/$fname")"
  run_sql "$fname 入账" \
    "insert into supabase_migrations.schema_migrations (version, name)
     values ('$v','$fname')
     on conflict (version) do nothing;"
done

echo
echo "=============================================================="
echo "✅ 生产交付完成,最终核对:"
run_sql "账本版本数" \
  "select count(*) as n from supabase_migrations.schema_migrations;"
run_sql "0028-0035 关键表存在性" \
  "select
     to_regclass('public.memories') as memories,
     to_regclass('public.mcp_servers') as mcp_servers,
     to_regclass('public.skills') as skills,
     to_regclass('public.skill_files') as skill_files,
     to_regclass('public.stripe_customers') as stripe_customers,
     to_regclass('public.subscriptions') as subscriptions,
     to_regclass('public.entitlements') as entitlements,
     to_regclass('public.usage_metering') as usage_metering;"
run_sql "0028-0035 函数存在性" \
  "select proname from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('recall_memories','touch_memory','get_entitlements','bump_usage','get_monthly_usage')
   order by proname;"
echo "=============================================================="
