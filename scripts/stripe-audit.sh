#!/usr/bin/env bash
# =============================================================================
# Stripe 侧只读体检 —— 支付闭环卡在哪一环,一次看全
#
# 为什么存在:应用侧能自证的只有「端点会拒绝无签名请求」「未登录会 401」。
# 真正决定钱能不能变成权益的四件事全在 Stripe 那边,应用侧一律看不见:
#   1. 密钥是 live 还是 test(test 密钥查的是空目录,价格永远解析不出来)
#   2. 四条价格在不在、金额对不对、有没有 metadata.plan_id
#   3. webhook 端点登记了没有、**订阅了哪些事件**
#      ——「只订阅 account.* 默认事件」会让付款成功而权益永不解锁,
#        而且从应用侧完全看不出来:签名守卫照常返回 400,一切看起来正常
#   4. Stripe 那边到底有没有过订阅/结账事件(有 = 收过钱没交付,最坏的一种)
#
# 只读:全部是 GET。不创建、不修改、不删除任何 Stripe 对象。
# 不打印密钥,只打印它的模式前缀。
#
# 用法:
#   bash scripts/stripe-audit.sh
#   STRIPE_SECRET_KEY=sk_live_xxx bash scripts/stripe-audit.sh
# =============================================================================
set -uo pipefail

SK="${STRIPE_SECRET_KEY:-}"
if [ -z "$SK" ]; then
  for f in "$HOME/Desktop/zhiyi-ai/.env.local" "$(dirname "$0")/../.env.local"; do
    [ -f "$f" ] || continue
    SK=$(grep -m1 '^STRIPE_SECRET_KEY=' "$f" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
    [ -n "$SK" ] && { echo "(密钥取自 $f)"; break; }
  done
fi
if [ -z "$SK" ]; then
  echo "❌ 找不到 STRIPE_SECRET_KEY。设环境变量后重跑:" >&2
  echo "   STRIPE_SECRET_KEY=sk_live_xxx bash scripts/stripe-audit.sh" >&2
  exit 2
fi

MODE=$(printf '%s' "$SK" | cut -c1-8)
echo "=============================================================="
echo "Stripe 只读体检   密钥模式: ${MODE}…"
echo "=============================================================="

get() { curl -sS --max-time 30 -u "$SK:" "https://api.stripe.com/v1/$1"; }
py() { python3 -c "$1"; }

echo
echo "── 1. 账户 ────────────────────────────────────────────────────"
get "account" | py "
import sys,json
d=json.load(sys.stdin)
if 'error' in d: print('  ERR:', d['error'].get('message')); sys.exit()
print('  账户   :', d.get('id'))
print('  国家   :', d.get('country'), '| 默认币种:', (d.get('default_currency') or '').upper())
print('  可收款 :', d.get('charges_enabled'), '| 可打款:', d.get('payouts_enabled'))
"

echo
echo "── 2. 价格目录(应有 4 条 HKD:4900/49000/22900/229000)──────────"
get "prices?active=true&limit=100&expand[]=data.product" | py "
import sys,json
d=json.load(sys.stdin)
if 'error' in d: print('  ERR:', d['error'].get('message')); sys.exit()
rows=d.get('data',[])
print(f'  active 价格共 {len(rows)} 条')
want={4900:'STRIPE_PRICE_PROFESSIONAL',49000:'STRIPE_PRICE_PROFESSIONAL_YEAR',
      22900:'STRIPE_PRICE_ENTERPRISE',229000:'STRIPE_PRICE_ENTERPRISE_YEAR'}
hit={}
for p in rows:
    prod=p.get('product') or {}
    name=prod.get('name') if isinstance(prod,dict) else str(prod)
    amt=p.get('unit_amount'); cur=(p.get('currency') or '').upper()
    itv=(p.get('recurring') or {}).get('interval')
    plan=(p.get('metadata') or {}).get('plan_id')
    print(f\"  {p['id']}  {amt} {cur} /{itv}  产品={name}  metadata.plan_id={plan or '(空)'}\")
    if cur=='HKD' and amt in want: hit[amt]=p['id']
print()
print('  → 建议写入 Vercel 生产环境变量:')
for amt,var in want.items():
    print(f\"     {var}={hit.get(amt,'!! 目录里没有匹配的 HKD 价格')}\")
missing=[v for a,v in want.items() if a not in hit]
if missing: print('  ⚠ 缺口:', ', '.join(missing))
else: print('  ✅ 四条价格齐全')
"

echo
echo "── 3. Webhook 端点(病根 3:只订阅 account.* 会让权益永不解锁)──"
get "webhook_endpoints?limit=20" | py "
import sys,json
d=json.load(sys.stdin)
if 'error' in d: print('  ERR:', d['error'].get('message')); sys.exit()
need={'checkout.session.completed','customer.subscription.created',
      'customer.subscription.updated','customer.subscription.deleted',
      'invoice.payment_failed'}
rows=d.get('data',[])
if not rows: print('  !! 一个端点都没有 —— 付款永远不会变成权益')
for w in rows:
    ev=set(w.get('enabled_events') or [])
    print(f\"  {w['id']}  status={w.get('status')}\")
    print(f\"    url    : {w.get('url')}\")
    if '*' in ev:
        print('    事件   : * (全部事件) ✅')
    else:
        miss=need-ev
        print(f\"    事件数 : {len(ev)}\")
        print('    缺失   :', (', '.join(sorted(miss)) if miss else '无 ✅'))
    print(f\"    路径对不对: {'✅' if str(w.get('url','')).endswith('/api/billing/webhook') else '⚠ 应以 /api/billing/webhook 结尾'}\")
"

echo
echo "── 4. Payment Link(备用路径,确认 active 且指向上面的价格)──────"
get "payment_links?limit=20" | py "
import sys,json
d=json.load(sys.stdin)
if 'error' in d: print('  ERR:', d['error'].get('message')); sys.exit()
for p in d.get('data',[]):
    print(f\"  {p['id']}  active={p.get('active')}  {p.get('url')}\")
"

echo
echo "── 5. 已有订阅 / 结账事件(有记录却库里没有 = 收了钱没交付)──────"
get "subscriptions?limit=10&status=all" | py "
import sys,json
d=json.load(sys.stdin)
if 'error' in d: print('  ERR:', d['error'].get('message')); sys.exit()
rows=d.get('data',[])
print(f'  Stripe 侧订阅数: {len(rows)}')
for s in rows:
    md=(s.get('metadata') or {}).get('userId')
    print(f\"    {s['id']}  status={s.get('status')}  customer={s.get('customer')}  metadata.userId={md or '(空 —— Payment Link 购买,靠邮箱反查)'}\")
"
get "events?type=checkout.session.completed&limit=5" | py "
import sys,json
d=json.load(sys.stdin)
if 'error' in d: print('  ERR:', d['error'].get('message')); sys.exit()
rows=d.get('data',[])
print(f'  历史 checkout.session.completed 事件: {len(rows)} 条(最近 5)')
for e in rows:
    print(f\"    {e['id']}  created={e.get('created')}\")
"

echo
echo "=============================================================="
echo "对照:生产库当前 subscriptions=0 / stripe_customers=0"
echo "  · 第 5 节有订阅或事件 → 钱收到了但没落库(webhook 投递/归属问题)"
echo "  · 第 5 节是 0        → 从来没人付过款,闭环还没被走过一次"
echo "=============================================================="
