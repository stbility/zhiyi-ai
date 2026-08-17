# E2E 生产验证 Secrets 约定

> 2026-08-17,双仓库二合一:验证资产自 `stbility/zhiyi-agent-e2e` 移入本仓
> (`scripts/e2e/` + `.github/workflows/hermes-e2e.yml`)。验证仓归档冻结。

## 触发方式

`.github/workflows/hermes-e2e.yml` 仅 `workflow_dispatch` 手动触发(不阻塞 PR CI):

```bash
# read 模式:只读仓库证明(MCP 工具调用 + 能力检测)
gh workflow run hermes-e2e.yml -f mode=read

# write 模式:受控 Draft PR 证明(需显式确认串)
gh workflow run hermes-e2e.yml -f mode=write -f write_confirmation=CREATE_DRAFT_PR
```

## Secrets 清单(GitHub Actions secrets,值一律不落库/不入代码)

| Secret | 用途 | 必填 |
|---|---|---|
| `ZHIYI_HERMES_MCP_TOKEN` | 主链路 MCP 鉴权(生产库 `mcp_access_tokens` 有效令牌) | ✅ |
| `ZHIYI_OPENCLAW_MCP_TOKEN` | OpenClaw MCP 鉴权(同上) | ✅ |
| `HERMES_MODEL_API_KEY` | 主模型 API key(按 provider 注入 `OPENAI_API_KEY`/`GEMINI_API_KEY`) | ✅ |
| `HERMES_MODEL_BASE_URL` | 主模型端点(如 `https://integrate.api.nvidia.com/v1`,须 HTTP(S) 前缀) | ✅ |
| `HERMES_MODEL_NAME` | 主模型 id(如 `openai/gpt-oss-120b`) | ✅ |
| `HERMES_FALLBACK_1_BASE_URL/_API_KEY/_MODEL` | fallback 1(OpenRouter,三件套齐才生效) | 可选 |
| `HERMES_FALLBACK_2_*` | fallback 2(Groq) | 可选 |
| `HERMES_FALLBACK_3_*` | fallback 3(未配) | 可选 |
| `HERMES_MODEL_GPT_OSS_20B` 等 worker 模型变量 | Worker/次要模型单次最小调用验证 | 可选 |

## 关键约定

- **Provider 识别**:workflow 内按 base_url 自动识别
  (`generativelanguage.googleapis.com`→gemini、`integrate.api.nvidia.com`→nvidia、
  `openrouter.ai`→openrouter、其余→openai-api),与 `scripts/e2e/provider_capabilities.py`
  同源判定。
- **fallback 降级不是失败**:日志 `Primary auth failed — switching to fallback`
  是正常降级,workflow 失败关键字检查已排除(见 `hermes-e2e.yml` 失败检查段)。
- **凭据纪律**:所有输出经 `sed` 脱敏(`Bearer [REDACTED]`/key 前缀截断);
  令牌只经 GitHub secrets 注入,不出现在代码/日志/artifact。
- **artifact 保留**:`hermes-*.log` 上传 artifact,保留 14 天,作为 E2E 证据。

## 与主仓生产库的关系

- MCP 令牌 = 生产库 `mcp_access_tokens` 表有效行(哈希比对鉴权,tokens.ts)。
- 双令牌时间线:Hermes Agent(VX41T,2026-08-13)、OpenClaw(9FBG3I,2026-08-06);
  E2E 预检 ping 实证令牌有效性(`last_used_at` 更新)。

## 历史(验证仓提交链,已并入)

`288c8a0`→`498972d`→`506e3b0`→`54a55c9`→`24d3e18`→`c205c55`→`81d2b52`→`d1c23f8`→`31c9451`→`00011d5`
