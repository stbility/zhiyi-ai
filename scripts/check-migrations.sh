#!/usr/bin/env bash
# 在一个**真实的 PostgreSQL** 上从空库重放全部迁移,再核对最终状态。
#
# 【为什么必须是真库】
# 此前迁移的验证全靠对文件内容做正则匹配 —— 检查的是「文件里写没写这句话」,
# 而不是「全部跑完之后库长什么样」。它漏掉了整整一条迁移:生产账本里有
# merge_overlapping_policies_and_fk_indexes,仓库里没有文件,编号从 0011
# 直接跳到 0013,而所有测试都是绿的。
#
# 静态重放(tests/app/migration-final-state.test.ts)能挡住「漏了整条迁移」
# 和「策略集合漂移」,但挡不住语法错误、依赖顺序、约束冲突 ——
# 那些只有真的跑一遍才知道。
#
# 【它验证什么、不验证什么】
# 验证:每条迁移都能在前一条的基础上成功执行;跑完之后的策略与索引集合
#       与生产一致。
# 不验证:RLS 在真实用户身份下的放行行为 —— 引导脚本里的 auth.uid()
#       永远返回 NULL,不模拟任何会话。那需要真实的 GoTrue。
#
# 【为什么用 psql 而不是 Node 客户端】
# 这个项目对依赖很克制(App JWT 都是手写的,避开供应链风险)。
# 为了跑一次迁移引入一个数据库驱动不值得 —— runner 自带 psql。
#
# 用法:DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
#         bash scripts/check-migrations.sh

set -euo pipefail

: "${DATABASE_URL:?需要 DATABASE_URL}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ON_ERROR_STOP=1 是关键:不带它,psql 会跳过报错的语句继续往下跑,
# 最后以 0 退出 —— 一条根本没建成的表会被当成建成了。
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet --no-psqlrc)

echo "── 引导(角色、auth schema、pgcrypto)"
"${PSQL[@]}" -f "$ROOT/supabase/test/bootstrap.sql"

echo "── 按顺序重放迁移"
count=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  # --single-transaction:一条迁移要么整条生效,要么整条回滚。
  # 不这样的话,一条迁移执行到一半失败会留下半成品,
  # 后面的报错全是连带的,根本看不出是哪一条先坏的。
  if "${PSQL[@]}" --single-transaction -f "$f"; then
    echo "  ✓ $(basename "$f")"
    count=$((count + 1))
  else
    echo "  ✗ $(basename "$f") 执行失败"
    echo ""
    echo "从零重建数据库这条路是断的 —— 灾难恢复用不了。"
    exit 1
  fi
done

echo "── 核对最终状态"
q() { "${PSQL[@]}" --tuples-only --no-align -c "$1" | sed '/^$/d' | sort; }

q "select policyname from pg_policies where schemaname='public'" > /tmp/actual-policies.txt
q "select indexname from pg_indexes where schemaname='public' and indexname not like '%\_pkey' and indexname not like '%\_key'" > /tmp/actual-indexes.txt

sort "$ROOT/supabase/test/expected-policies.txt" > /tmp/expected-policies.txt
sort "$ROOT/supabase/test/expected-indexes.txt" > /tmp/expected-indexes.txt

# 守卫不能空转:期望清单为空的话,下面的 diff 会全绿而毫无意义
if [ "$(wc -l < /tmp/expected-policies.txt)" -lt 40 ]; then
  echo "✗ 期望策略清单太短 —— 核对是空转的"
  exit 1
fi

fail=0
if ! diff -u /tmp/expected-policies.txt /tmp/actual-policies.txt; then
  echo "✗ 策略集合与生产不一致(- 是生产有而重建缺,+ 是重建多出来)"
  fail=1
fi
if ! diff -u /tmp/expected-indexes.txt /tmp/actual-indexes.txt; then
  echo "✗ 索引集合与生产不一致"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "重建出来的库与生产不是同一个东西。缺策略 → 功能坏;多策略 → 权限可能变宽。"
  exit 1
fi

echo ""
echo "✓ 从空库重放 $count 条迁移成功,最终状态与生产一致。"
