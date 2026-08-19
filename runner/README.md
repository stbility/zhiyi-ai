# 智一 Agent Runner(阶段 B 骨架)

长时 Agent 执行承载层 —— 脱离 Vercel Function 300s 生命周期的持久 Runner。

## 架构(冻结,Phase 2.2)

```
Web/API → agent_runs(queued)→ 持久 Runner → Hermes ACP(阶段 C)→ ZHIYI MCP → Tools
                                          → agent_steps / checkpoint / finish
```

Runner 是**执行承载层**,不是第二套 Agent Runtime:
- Agent Loop / Tool Result Injection / Continuation 由 Hermes ACP 提供(阶段 C)
- Runner 只负责:queue / claim / lease / generation fencing / slot pool / 终态

## 组件

| 文件 | 职责 |
|---|---|
| `src/claim.ts` | FOR UPDATE SKIP LOCKED 原子领取 + lease 写入(D3 冻结) |
| `src/heartbeat.ts` | 租约续期(带 generation 校验) |
| `src/fence.ts` | 写保护:agent_steps 插入 / checkpoint / finish 全部带 generation |
| `src/slot-pool.ts` | 并发槽位池(工程上限,商业上限由 checkConcurrentTasks 强制) |
| `src/runner.ts` | 主循环:poll → claim → execute → finish + graceful shutdown |
| `src/index.ts` | 入口:pg 连接池 + health 端点(:8787)+ SIGTERM 优雅关闭 |

## 运行

```bash
cd runner
npm install
RUNNER_DATABASE_URL=postgres://... npx tsx src/index.ts
# health:curl localhost:8787/healthz
```

环境变量:
- `RUNNER_DATABASE_URL`(必填,service role 权限)
- `RUNNER_SLOTS`(默认 2)
- `RUNNER_WORKER_ID`(默认 hostname+pid+ts)

## 测试

```bash
cd runner && npx vitest run
```

## 冻结边界(不可违反)

- claim 唯一方式:FOR UPDATE SKIP LOCKED 原子事务(禁止先 SELECT 再 UPDATE)
- 所有写操作携带 { run_id, lease_generation };0 行 = fence lost → abort + 退出
- 状态机只用现有八态,不新增 hermes_running/acp_cancelled 等业务状态
- 不修改 /api/agent 同步链路、P1、Workflow、billing/entitlement/usage
