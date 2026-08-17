#!/usr/bin/env python3
"""Provider / Model capability registry for the Zhiyi Agent OS.

运行时只读注册表:给定 Base URL / Provider / Model,返回:
  - provider kind(openai-compatible / gemini-native / ...)
  - protocol(openai_chat / gemini_native / ...)
  - capability profile(该模型支持哪些任务能力)

不执行网络请求,不接触任何密钥。供 E2E 校验与 Dashboard
能力检测共用同一份判定逻辑(Single Source of Truth)。

任务能力(Task Capabilities):
  text, coding, agent, vision, image, video, tools, multi_turn, streaming

能力判定依据(不猜测,只做确定性映射):
  - Base URL host 决定 provider kind / protocol
  - 已知模型前缀映射能力;未知模型保守返回基础能力
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Provider kinds
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ProviderSpec:
    kind: str                 # "openai-compatible" | "gemini-native" | ...
    protocol: str             # "openai_chat" | "gemini_native" | ...
    label: str
    hosts: Tuple[str, ...]    # 识别的 host(小写、去端口)

PROVIDERS: Tuple[ProviderSpec, ...] = (
    ProviderSpec("gemini-native", "gemini_native", "Google Gemini",
                 ("generativelanguage.googleapis.com",)),
    ProviderSpec("openai-compatible", "openai_chat", "NVIDIA NIM",
                 ("integrate.api.nvidia.com",)),
    ProviderSpec("openai-compatible", "openai_chat", "OpenRouter",
                 ("openrouter.ai",)),
    ProviderSpec("openai-compatible", "openai_chat", "Groq",
                 ("api.groq.com",)),
    ProviderSpec("openai-compatible", "openai_chat", "DeepSeek",
                 ("api.deepseek.com",)),
    ProviderSpec("openai-compatible", "openai_chat", "OpenAI",
                 ("api.openai.com",)),
)

# Hermes 内置 provider 名(workflow 用;registry 与 workflow 共用同一判定)
HERMES_PROVIDER_BY_HOST: Dict[str, str] = {
    "generativelanguage.googleapis.com": "gemini",
    "integrate.api.nvidia.com": "nvidia",
    "openrouter.ai": "openrouter",
}


def hermes_provider_for_base_url(base_url: str) -> str:
    """返回 Hermes --provider 名(与 workflow 的判定一致)。"""
    url = (base_url or "").strip().lower().rstrip("/")
    for host, provider in HERMES_PROVIDER_BY_HOST.items():
        if host in url:
            return provider
    return "openai-api"


def detect_provider(base_url: str) -> ProviderSpec:
    """按 Base URL host 自动识别 Provider(不要求用户填代码级类型)。"""
    url = (base_url or "").strip().lower().rstrip("/")
    if not url:
        return ProviderSpec("unknown", "unknown", "unknown", ())
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).netloc or "").split(":")[0].lower()
    except Exception:
        host = ""
    for spec in PROVIDERS:
        if host in spec.hosts:
            return spec
    # 无法识别的 host:一律按 OpenAI-compatible 处理(通用网关/自建 vLLM 等)
    return ProviderSpec("openai-compatible", "openai_chat", host or "unknown", (host,))


# ---------------------------------------------------------------------------
# Model capability profiles(确定性映射,不猜测)
# ---------------------------------------------------------------------------

# 已知模型 → 能力。前缀匹配(如 "gemini-3.5-flash" 命中 "gemini-3.5-flash")。
# 未知模型走 _default_profile() 保守返回。
_MODEL_CAPABILITIES: Dict[str, frozenset] = {
    # Google Gemini(原生)
    "gemini-3.5-flash": frozenset({
        "text", "coding", "agent", "vision", "tools", "multi_turn", "streaming",
    }),
    "gemini-3.1-flash-lite": frozenset({
        "text", "agent", "tools", "multi_turn", "streaming",
    }),
    # NVIDIA NIM(OpenAI 兼容)
    "openai/gpt-oss-120b": frozenset({
        "text", "coding", "agent", "tools", "multi_turn", "streaming",
    }),
    "openai/gpt-oss-20b": frozenset({
        "text", "coding", "agent", "tools", "multi_turn", "streaming",
    }),
    # OpenRouter
    "openai/gpt-oss-20b:free": frozenset({
        "text", "coding", "agent", "tools", "multi_turn", "streaming",
    }),
    # Groq
    "openai/gpt-oss-120b": frozenset({
        "text", "coding", "agent", "tools", "multi_turn", "streaming",
    }),
}

# 默认保守能力(未知模型):有 text/multi_turn 即可,不宣称高级能力
_DEFAULT_CAPS: frozenset = frozenset({"text", "multi_turn"})


def model_capabilities(model: str, base_url: str = "") -> frozenset:
    """返回模型能力 profile(精确/前缀匹配;未知走保守默认)。"""
    name = (model or "").strip()
    if not name:
        return frozenset(_DEFAULT_CAPS)
    lowered = name.lower()
    # 精确匹配
    if lowered in _MODEL_CAPABILITIES:
        return _MODEL_CAPABILITIES[lowered]
    # 前缀匹配(如 "gemini-3.7-flash" → 找 "gemini-" 前缀的并集)
    prefixes = ("gemini-", "openai/", "qwen", "deepseek", "gpt-", "claude-")
    for prefix in prefixes:
        if lowered.startswith(prefix):
            union: frozenset = frozenset(_DEFAULT_CAPS)
            for key, caps in _MODEL_CAPABILITIES.items():
                if key.startswith(prefix):
                    union = union | caps
            if union != frozenset(_DEFAULT_CAPS):
                return union
    return frozenset(_DEFAULT_CAPS)


# ---------------------------------------------------------------------------
# 任务能力匹配
# ---------------------------------------------------------------------------

TASK_TO_REQUIRED: Dict[str, frozenset] = {
    "text":   frozenset({"text"}),
    "coding": frozenset({"text", "coding"}),
    "agent":  frozenset({"text", "tools", "multi_turn"}),
    "vision": frozenset({"text", "vision"}),
    "image":  frozenset({"text", "image"}),
    "video":  frozenset({"text", "video"}),
}


def supports_task(model: str, task: str, base_url: str = "") -> bool:
    """模型是否满足任务能力要求。不满足 → 不得进入 Primary。"""
    caps = model_capabilities(model, base_url)
    required = TASK_TO_REQUIRED.get(task, frozenset({"text"}))
    return required.issubset(caps)


def capabilities_report(base_url: str, model: str) -> Dict[str, object]:
    """给 E2E / Dashboard 使用的完整报告(无任何密钥)。"""
    spec = detect_provider(base_url)
    caps = model_capabilities(model, base_url)
    return {
        "provider": spec.kind,
        "label": spec.label,
        "protocol": spec.protocol,
        "model": model,
        "capabilities": sorted(caps),
        "tasks": {
            t: supports_task(model, t, base_url) for t in TASK_TO_REQUIRED
        },
    }


if __name__ == "__main__":
    import json
    import sys
    samples = [
        ("https://generativelanguage.googleapis.com/v1beta", "gemini-3.5-flash"),
        ("https://integrate.api.nvidia.com/v1", "openai/gpt-oss-120b"),
        ("https://openrouter.ai/api/v1", "openai/gpt-oss-20b:free"),
        ("https://api.groq.com/openai/v1", "openai/gpt-oss-120b"),
        ("https://my-gateway.example.com/v1", "custom-model-x"),
    ]
    for url, model in samples:
        print(json.dumps(capabilities_report(url, model), ensure_ascii=False))
