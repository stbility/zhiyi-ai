#!/usr/bin/env python3
"""Write an isolated Hermes config without exposing credentials to logs.

Provider 链路(2026-08-15 升级):不写死任何服务商。
- 主模型:openai-api(通用 OpenAI 兼容),端点/密钥来自
  OPENAI_BASE_URL / OPENAI_API_KEY 环境变量。
- fallback 链:HERMES_FALLBACK_<N>_BASE_URL / _API_KEY / _MODEL(N=1,2,3...)
  按顺序追加。主模型遇限速/过载/连接错误时自动切换(Groq 429 等)。
- 换服务商/加备胎 = 只改 secrets,不动代码。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse


def _provider_for_base_url(base_url: str) -> str:
    """按端点识别 Provider 类型(不写死服务商,不新增变量)。

    - generativelanguage.googleapis.com → gemini(Hermes 原生 provider,
      Google Generative Language API,非 OpenAI 兼容)
    - 其余 → openai-api(通用 OpenAI 兼容:Groq/OpenRouter/DeepSeek 等)

    host 用 urlparse 精确比较而非子串匹配:
    `\"generativelanguage.googleapis.com\" in url` 会把
    `https://evilgenerativelanguage.googleapis.com` 之类伪装域名误判为
    gemini(code scanning alert #12:py/incomplete-url-substring-sanitization)。
    """
    host = (urlparse(base_url).hostname or "").lower()
    if host == "generativelanguage.googleapis.com":
        return "gemini"
    return "openai-api"


def _fallback_entries() -> list[dict[str, object]]:
    """读 HERMES_FALLBACK_<N>_* 环境变量,构造 fallback 链(保序)。"""
    entries: list[dict[str, object]] = []
    idx = 1
    while True:
        base_url = os.environ.get(f"HERMES_FALLBACK_{idx}_BASE_URL", "").strip()
        api_key = os.environ.get(f"HERMES_FALLBACK_{idx}_API_KEY", "").strip()
        model = os.environ.get(f"HERMES_FALLBACK_{idx}_MODEL", "").strip()
        if not base_url or not api_key or not model:
            break  # 编号不连续即停止(HERMES_FALLBACK_1_* 未配 = 无 fallback)
        entries.append(
            {
                # 原生识别:gemini 走 Native API,其它走 OpenAI 兼容
                "provider": _provider_for_base_url(base_url),
                "model": model,
                "base_url": base_url,
                # Hermes 约定:key_env 指向环境变量名,密钥不落盘
                "key_env": f"HERMES_FALLBACK_{idx}_API_KEY",
            }
        )
        idx += 1
    return entries


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: write_hermes_config.py OUTPUT")

    url = os.environ.get("ZHIYI_MCP_URL", "")
    token = os.environ.get("ZHIYI_MCP_TOKEN", "")
    if not url or not token:
        raise SystemExit("missing Zhiyi MCP URL or token")

    # JSON is valid YAML 1.2 and avoids hand-written escaping problems in tokens.
    primary_base_url = os.environ.get("HERMES_MODEL_BASE_URL", "").strip()
    config = {
        "model": {
            # Provider-neutral:按主端点自动识别 provider 类型。
            # Gemini 原生端点 → gemini(Google Generative Language API,
            # 非 OpenAI 兼容);其余 OpenAI 兼容端点 → openai-api。
            # 换服务商只改 HERMES_MODEL_* secrets,不改代码。
            "provider": _provider_for_base_url(primary_base_url),
            "default": os.environ.get("HERMES_MODEL_NAME", ""),
            "api_mode": "chat_completions",
        },
        "fallback_providers": _fallback_entries(),
        "auxiliary": {
            "vision": {"provider": "main"},
            "web_extract": {"provider": "main"},
            "compression": {"provider": "main"},
            "skills_hub": {"provider": "main"},
            "mcp": {"provider": "main"},
            "approval": {"provider": "main"},
            "title_generation": {"provider": "main"},
            "triage_specifier": {"provider": "main"},
        },
        "mcp_servers": {
            "zhiyi": {
                "url": url,
                "headers": {"Authorization": f"Bearer {token}"},
            }
        }
    }
    output = Path(sys.argv[1])
    output.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    output.chmod(0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
