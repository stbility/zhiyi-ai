#!/usr/bin/env python3
"""Check primary model capability for agent task (called by workflow).

Reads HERMES_MODEL_BASE_URL / HERMES_MODEL_NAME from env, resolves the
provider + capability profile, and fails (exit 2) when the primary model
cannot satisfy the agent task requirements (text + tools + multi_turn).

Output is a single safe line: no keys, no secrets.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from provider_capabilities import (  # noqa: E402
    TASK_TO_REQUIRED,
    detect_provider,
    model_capabilities,
)


def main() -> int:
    url = os.environ.get("HERMES_MODEL_BASE_URL", "")
    model = os.environ.get("HERMES_MODEL_NAME", "")
    spec = detect_provider(url)
    caps = model_capabilities(model, url)
    need = TASK_TO_REQUIRED.get("agent", frozenset())
    ok = need.issubset(caps)
    print(
        f"primary provider={spec.kind} protocol={spec.protocol} "
        f"model={model or '(unset)'} agent_capable={ok}"
    )
    if not ok:
        missing = sorted(need - caps)
        print(f"::error::Primary model missing agent capabilities: {missing}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
