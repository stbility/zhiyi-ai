# Supabase Advisor False Positive 归档方案

> **For Hermes:** 按 Task 分步执行，每步完成后等用户审阅再继续下一步。

**Goal:** 将 Supabase Advisor 中已判定为 false positive 的索引归档为 CI 可忽略的白名单，解除其对后续开发的阻塞。

**Architecture:** 在 `scripts/check-migrations.sh` 中新增 FK 维护索引白名单检查逻辑，与契约测试框架（`expected-indexes.txt` / `expected-policies.txt`）并列作为索引状态的双重真值源。

**Context:**

- 当前 Phase 4（智能体与工作流），Phase 5/6/7 依赖数据库健康状态无告警
- Supabase Advisor Performance 报 `messages_organization_idx` 未使用索引（idx_scan = 0）
- 0032 迁移已逐条审查过同类告警（4 条 FK 维护索引），结论：false positive，保留
- 0050 曾误删 4 条 FK 维护索引 → 0051 紧急恢复，生产事故
- `messages_organization_idx` 索引列 `organization_id` 是外键，`ON DELETE CASCADE`，用于级联删除定位；idx_scan 不统计 FK 内部使用

---

## Task 1: 整理已判定 false positive 清单（生产实证）

**Objective:** 提取生产统计信息，确认当前 idx_scan = 0 的索引全为 FK 维护用途。

**Files:**
- 查询目标: Supabase 生产库（项目 `ullmdnbgtauupndwqqzd`）

**Step 1: 生产库查询（curl + Supabase REST API）**

```bash
# 查询 messages_organization_idx 统计信息（需要 SERVICE_ROLE_KEY 或统计视图）
# 以下查询通过 anon key + RPC 带命名参数探测（已知可通）

# 查 pg_stat_user_indexes 中 messages_organization_idx 的 idx_scan
curl -s "https://ullmdnbgtauupndwqqzd.supabase.co/rest/v1/rpc/pg_stat_get_idx_scan" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  --data '{"p_idxname":"messages_organization_idx"}'
```

**Step 2: 对照 0032 已判定清单**

已在会话历史中确认的 false positive（来源: 0032 迁移注释 + 代码映射）:

| 索引名 | 用途 | 判定依据 |
|---|---|---|
| `messages_organization_idx` | `organization_id` FK 维护，ON DELETE CASCADE | idx_scan 不统计 FK 内部使用；代码 0 处按该列查询 |
| `conversation_attachments_organization_idx` | `organization_id` FK 维护 | 同上 |
| `ai_providers_created_by_idx` | `created_by` FK 维护，ON DELETE SET NULL/RESTRICT | 同上 |
| `audit_logs_actor_idx` | `actor` FK 维护，ON DELETE SET NULL | 同上 |
| `organizations_created_by_idx` | `created_by` FK 维护，ON DELETE RESTRICT | 同上 |

**验证命令:** 无（已在历史会话中完成四层映射：官方规则原文 → 迁移 SQL → 代码路径 → 真实数据量）

---

## Task 2: 创建白名单配置文件

**Objective:** 建立 `/Users/kuanxu/Desktop/zhiyi-ai/supabase/advisor-whitelist.json`，格式如下：

```json
{
  "version": "2026-08-10",
  "rules": {
    "unused_index": {
      "reason": "FK维护索引，idx_scan不统计FK内部使用，删除导致级联删除退化为全表扫",
      "indexes": [
        "messages_organization_idx",
        "conversation_attachments_organization_idx",
        "ai_providers_created_by_idx",
        "audit_logs_actor_idx",
        "organizations_created_by_idx"
      ]
    }
  }
}
```

**Files:**
- 创建: `supabase/advisor-whitelist.json`

**Step 1: 写入文件**

```bash
# 内容见上方 JSON
```

**Step 2: 提交到新分支**

```bash
git checkout -b fix/advisor-whitelist
git add supabase/advisor-whitelist.json
git commit -m "docs: 建立 Supabase Advisor false positive 白名单"
git push -u origin fix/advisor-whitelist
gh pr create --title "docs: Advisor false positive 白名单归档" --body "新建白名单配置文件，记录已判定 false positive 的 FK 维护索引"
```

---

## Task 3: 在 check-migrations.sh 中集成白名单检查

**Objective:** 让 CI 在 Advisor 告警出现时，先查白名单，已归档者不阻塞 CI。

**Files:**
- 修改: `scripts/check-migrations.sh`

**Step 1: 读取当前 check-migrations.sh 结构**

```bash
cat scripts/check-migrations.sh
```

**Step 2: 在索引检查段落插入白名单过滤逻辑**

在 `expected-indexes.txt` 对比逻辑之前插入：

```bash
# === Supabase Advisor False Positive 白名单过滤 ===
WHITELIST_FILE="supabase/advisor-whitelist.json"
ADVISOR_ALERT_FILE="${1:-/dev/stdin}"

if [ -f "$WHITELIST_FILE" ]; then
  echo "[Advisor Whitelist] 过滤已知 false positive..."
  # 从 Advisor 告警中剔除白名单中的索引名
  python3 -c "
import json, sys
with open('$WHITELIST_FILE') as f:
    wl = json.load(f)
whitelisted = wl.get('rules', {}).get('unused_index', {}).get('indexes', [])
# 读取 CI 报告的告警（每行一个索引名）
alerts = [line.strip() for line in sys.stdin if line.strip()]
filtered = [a for a in alerts if a not in whitelisted]
for a in filtered:
    print(a)
" > /tmp/filtered-alerts.txt
  cat /tmp/filtered-alerts.txt
else
  cat $ADVISOR_ALERT_FILE > /tmp/filtered-alerts.txt
fi
```

**Step 3: 验证**

```bash
# 模拟白名单过滤（已知 false positive 应被移除）
echo "messages_organization_idx" | python3 -c "
import json, sys
with open('supabase/advisor-whitelist.json') as f:
    wl = json.load(f)
whitelisted = wl.get('rules', {}).get('unused_index', {}).get('indexes', [])
alerts = [line.strip() for line in sys.stdin if line.strip()]
filtered = [a for a in alerts if a not in whitelisted]
print('filtered:', filtered)
"
# 预期输出: filtered: []（白名单中的索引被移除）
```

---

## Task 4: 更新 expected-indexes.txt（契约快照）

**Objective:** 确保白名单中的索引在契约测试中标记为"预期存在但 idx_scan=0 可接受"。

**Files:**
- 修改: `supabase/test/expected-indexes.txt`

**Step 1: 读取当前 expected-indexes.txt**

```bash
cat supabase/test/expected-indexes.txt
```

**Step 2: 在白名单索引行后添加注释**

```
messages_organization_idx               # FK维护索引，白名单false positive，idx_scan不统计FK使用
conversation_attachments_organization_idx # 同上
ai_providers_created_by_idx             # 同上
audit_logs_actor_idx                    # 同上
organizations_created_by_idx             # 同上
```

**Step 3: 提交**

```bash
git add supabase/test/expected-indexes.txt
git commit -m "test: 契约快照标注 FK 维护索引为已知 false positive"
```

---

## Task 5: 在 Supabase Dashboard 标记已解决（手动）

**Objective:** 在 Supabase Advisor UI 中 Dismiss 已归档的告警，防止重复出现干扰判断。

**手动操作（用户侧）:**

1. 打开 https://supabase.com/dashboard/project/ullmdnbgtauupndwqqzd/database/advisors
2. Performance → 找到 `messages_organization_idx` 告警
3. 点击 "Dismiss" 或 "Mark as resolved"
4. 对其它 4 条白名单索引重复操作

> 注意：Dismiss 只是隐藏该次告警，不影响数据库。新建索引/新告警不受影响。

---

## Task 6: 提交 PR，审阅后合并

**Objective:** 将白名单配置 + CI 集成 + 契约快照作为一个整体 PR 交付。

**PR 标题:** `fix(db): Advisor false positive 白名单归档 + CI 集成`

**审阅要点:**
- [ ] whitelist.json 格式正确，5 条索引名与迁移历史一致
- [ ] check-migrations.sh 改动不破坏现有契约测试
- [ ] expected-indexes.txt 注释清晰，不影响快照对比逻辑
- [ ] Dashboard 已手动 Dismiss

---

## 风险与 Tradeoffs

| 风险 | 缓解 |
|---|---|
| 白名单过期（新版本 Supabase 改了检查逻辑） | 版本号锁定（`version: "2026-08-10"`），后续需同步更新 |
| 白名单被误删导致真问题被隐藏 | CI 仍运行原始 Advisor 报告，白名单仅降级不静默 |
| Dashboard Dismiss 状态与 CI 报告不同步 | CI 使用白名单文件，Dashboard 仅人类参考，两者独立 |

## 开放问题

1. Supabase Advisor 是否支持 API 批量 Dismiss？（如支持，可自动化否则保留手动）
2. 白名单是否需要覆盖 Performance 以外的其他 Advisor 类型（Security / Security Info）？
3. Phase 6（Stripe 订阅）依赖的新迁移是否需要额外的 Advisor 检查？
