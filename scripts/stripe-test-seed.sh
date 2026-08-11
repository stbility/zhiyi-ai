#!/usr/bin/env bash
# =============================================================================
# Stripe **test mode** 目录种子 —— 把 4 条 HKD 价格建起来
#
# 为什么需要它:
#   Stripe 的 test mode 是**完全独立的命名空间**。live 模式下已有的产品和价格,
#   在 test 模式里一条都不存在(2026-08-09 实测:test 模式 active 价格 0 条)。
#   模拟支付跑不起来的第一个原因通常就是这个 —— 而且很容易误判成「代码有问题」。
#
# 幂等:按产品名 + (金额, 周期) 查重,已存在就复用,不会建出第二份。
# 可反复跑。
#
# 安全:
#   · 检测到 live 密钥**直接拒绝退出** —— 这个脚本只允许动测试账本。
#   · 不打印密钥,只打印它的模式前缀。
#
# 用法:
#   bash scripts/stripe-test-seed.sh
#   STRIPE_SECRET_KEY=sk_test_xxx bash scripts/stripe-test-seed.sh
# =============================================================================
set -uo pipefail

SK="${STRIPE_SECRET_KEY:-}"
if [ -z "$SK" ]; then
  for f in "$(dirname "$0")/../.env.local" "$HOME/Desktop/zhiyi-ai/.env.local"; do
    [ -f "$f" ] || continue
    SK=$(grep -m1 '^STRIPE_SECRET_KEY=' "$f" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
    [ -n "$SK" ] && { echo "(密钥取自 $f)"; break; }
  done
fi
if [ -z "$SK" ]; then
  echo "❌ 找不到 STRIPE_SECRET_KEY。" >&2
  exit 2
fi

case "$SK" in
  sk_test_*|rk_test_*) : ;;
  *)
    echo "❌ 拒绝执行:这不是 test 密钥(前缀 $(printf '%s' "$SK" | cut -c1-8)…)。" >&2
    echo "   本脚本会**创建** Stripe 对象,只允许在测试账本上跑。" >&2
    exit 3
    ;;
esac

echo "=============================================================="
echo "Stripe test mode 目录种子   密钥模式: $(printf '%s' "$SK" | cut -c1-8)…"
echo "=============================================================="

export SK
python3 <<'PY'
import json
import os
import urllib.parse
import urllib.request

SK = os.environ["SK"]
BASE = "https://api.stripe.com/v1/"


def call(path, data=None, method=None):
    url = BASE + path
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data, doseq=True).encode()
    req = urllib.request.Request(url, data=body, method=method or ("POST" if data else "GET"))
    req.add_header("Authorization", "Bearer " + SK)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = json.load(e)
        raise SystemExit(f"❌ Stripe API 报错 {e.code}: {detail.get('error', {}).get('message')}")


# 产品名必须含 price-catalog.ts 认的关键字(professional/专业、enterprise/企业),
# 否则目录自解析认不出套餐。
PLANS = [
    {
        "plan_id": "professional",
        "product_name": "Professional 专业版",
        "prices": [("month", 4900), ("year", 49000)],
    },
    {
        "plan_id": "enterprise",
        "product_name": "Enterprise 企业版",
        "prices": [("month", 22900), ("year", 229000)],
    },
]

existing_products = {p["name"]: p for p in call("products?active=true&limit=100").get("data", [])}
existing_prices = call("prices?active=true&limit=100").get("data", [])

resolved = {}

for plan in PLANS:
    name = plan["product_name"]
    product = existing_products.get(name)
    if product:
        print(f"\n产品「{name}」已存在 → {product['id']}")
    else:
        product = call(
            "products",
            {"name": name, "metadata[plan_id]": plan["plan_id"]},
        )
        print(f"\n产品「{name}」已创建 → {product['id']}")

    for interval, amount in plan["prices"]:
        hit = next(
            (
                p
                for p in existing_prices
                if p.get("product") == product["id"]
                and p.get("unit_amount") == amount
                and (p.get("recurring") or {}).get("interval") == interval
                and p.get("currency") == "hkd"
            ),
            None,
        )
        if hit:
            print(f"  {interval:5} HKD {amount:>6} 已存在 → {hit['id']}")
            price = hit
        else:
            price = call(
                "prices",
                {
                    "product": product["id"],
                    "unit_amount": amount,
                    "currency": "hkd",
                    "recurring[interval]": interval,
                    # metadata.plan_id 是 webhook 判定套餐的首选依据。
                    # 生产 live 目录这里是空的(病根 1 的一半) —— test 目录一开始就配对。
                    "metadata[plan_id]": plan["plan_id"],
                },
            )
            print(f"  {interval:5} HKD {amount:>6} 已创建 → {price['id']}")

        suffix = "" if interval == "month" else "_YEAR"
        resolved[f"STRIPE_PRICE_{plan['plan_id'].upper()}{suffix}"] = price["id"]

print("\n=============================================================="
      "\n可写入 .env.local(可选 —— 不写也能跑,price-catalog 会按产品名自解析)"
      "\n==============================================================")
for k in (
    "STRIPE_PRICE_PROFESSIONAL",
    "STRIPE_PRICE_PROFESSIONAL_YEAR",
    "STRIPE_PRICE_ENTERPRISE",
    "STRIPE_PRICE_ENTERPRISE_YEAR",
):
    print(f"{k}={resolved.get(k, '(未解析出)')}")
PY
