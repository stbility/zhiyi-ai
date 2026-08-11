#!/usr/bin/env bash
# 查询 Supabase Performance Advisor INFO 建议(通过 Management API)
# 用法: SUPABASE_ACCESS_TOKEN=sbp_xxx SUPABASE_PROJECT_REF=ullmdnbgtauupndwqqzd bash scripts/advisor-info.sh
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-ullmdnbgtauupndwqqzd}"
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
API="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"

if [ -z "$TOKEN" ]; then
  echo "❌ 缺少 SUPABASE_ACCESS_TOKEN" >&2
  exit 1
fi

json_body() { python3 -c "import json,sys; print(json.dumps({'query': sys.argv[1]}))" "$1"; }
api_raw() {
  curl -sS --max-time 60 -X POST "$API" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(json_body "$1")"
}

echo "=== Performance Advisor INFO 查询 ==="
echo "项目: $PROJECT_REF"
echo ""

# 检查 supabase_advisor.check_results 是否存在
CHECK_SQL="SELECT to_regclass('supabase_advisor.check_results') as tbl;"
RESULT=$(api_raw "$CHECK_SQL")
echo "Advisor 表检查: $RESULT"

if echo "$RESULT" | grep -q 'supabase_advisor.check_results'; then
  echo ""
  echo "--- 全量 INFO 建议 ---"
  api_raw "
    SELECT
      table_name,
      message,
      substr(detail, 1, 500) as detail,
      substr(recommendation, 1, 300) as recommendation
    FROM supabase_advisor.check_results
    WHERE severity = 'info'
    ORDER BY table_name, message;
  " | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        for i, row in enumerate(data, 1):
            print(f'[{i}] TABLE={row.get(\"table_name\",\"\")}')
            print(f'    MESSAGE: {row.get(\"message\",\"\")}')
            print(f'    DETAIL:  {str(row.get(\"detail\",\"\"))[:300]}')
            print(f'    RECOMMEND: {str(row.get(\"recommendation\",\"\"))[:200]}')
            print()
        print(f'总计: {len(data)} 条')
    else:
        print('ERR:', data)
except Exception as e:
    print('解析失败:', e)
    sys.stdin.seek(0)
    print(sys.stdin.read()[:2000])
"
else
  echo "supabase_advisor 扩展未安装或无法访问"
fi
