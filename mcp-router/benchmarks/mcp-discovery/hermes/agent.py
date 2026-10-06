"""JSON-lines adapter to the installed Hermes AIAgent, with fixture-only execution."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from typing import Any

Json = dict[str, Any]
wire = sys.stdout
lock = threading.RLock()


def emit(value: Json) -> None:
    with lock:
        wire.write(json.dumps(value, ensure_ascii=False, default=lambda obj: sorted(obj) if isinstance(obj, (set, frozenset)) else None) + "\n")
        wire.flush()


def make_handler(name: str):
    def execute(arguments: Json, **context: Any) -> str:
        # Hermes passes one argument dictionary and separate runtime context.
        # Pair parallel requests with their replies atomically.
        with lock:
            emit({"event": "call", "name": name, "args": arguments})
            reply = json.loads(sys.stdin.readline())
            return json.dumps(reply, ensure_ascii=False)
    return execute


def request_tools(arguments: Json) -> list[Json]:
    # Hermes's SDK bypass puts the real tools in extra_body, replacing empty slots.
    body = arguments.get("extra_body") or {}
    return body.get("tools", arguments.get("tools") or [])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-root", type=Path, required=True)
    parser.add_argument("--profile-home", type=Path, required=True)
    options = parser.parse_args()
    spec: Json = json.loads(sys.stdin.readline())
    # Hermes startup diagnostics go to stderr, separate from the benchmark protocol.
    sys.stdout = sys.stderr
    sys.path.insert(0, str(options.hermes_root))
    import hermes_bootstrap  # noqa: F401
    import hermes_yaml as yaml
    from hermes_cli.env_loader import load_hermes_dotenv
    load_hermes_dotenv(hermes_home=str(options.profile_home))
    original: Json = yaml.safe_load((options.profile_home / "config.yaml").read_text())
    model: str = original["model"].get("default") or original["model"].get("model")
    if model != "glm-5.3-flash":
        raise ValueError(f"Expected glm-5.3-flash; configured model is {model}")
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime: Json = resolve_runtime_provider(requested=original["model"].get("provider"), target_model=model)
    # Credentials remain in this process. No auth files are copied into temporary state.
    for key in list(sys.modules):
        if key.startswith(("hermes_cli", "tools.", "toolsets", "model_tools", "agent.", "run_agent")):
            del sys.modules[key]
    commit = subprocess.check_output(["git", "-C", str(options.hermes_root), "rev-parse", "HEAD"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="jev_hermes_benchmark_") as directory:
        os.environ["HERMES_HOME"] = directory
        os.chdir(directory)
        cfg: Json = {
            "model": {"default": model, "provider": runtime["provider"], "base_url": runtime.get("base_url", "")},
            "mcp_servers": {},
            "tools": {"tool_search": {"enabled": "on" if spec["arm"] == "native" else "off"}},
            "compression": {"enabled": False},
            "logging": {"level": "WARNING"},
        }
        Path(directory, "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
        from tools.registry import registry
        expected: set[str] = set()
        toolsets: set[str] = set()

        for tool in spec["tools"]:
            name = tool["name"]
            toolset = "mcp-" + tool["id"].split(".")[0]
            expected.add(name)
            toolsets.add(toolset)
            registry.register(name=name, toolset=toolset,
                              schema={"name": name, "description": tool["description"], "parameters": tool["inputSchema"]},
                              handler=make_handler(name))
        original_dispatch = registry.dispatch

        def only_fixtures(name: str, args: Json, **kwargs: Any) -> str:
            if name not in expected:
                raise RuntimeError(f"Blocked non-fixture registry execution: {name}")
            return original_dispatch(name, args, **kwargs)
        registry.dispatch = only_fixtures
        import agent.aux_accounting as aux_accounting
        from agent.usage_pricing import normalize_usage
        real_aux_record = aux_accounting.record_aux_usage

        def record_aux(response: Any, task: str | None, **kwargs: Any) -> None:
            if getattr(response, "usage", None):
                u = normalize_usage(response.usage, provider=kwargs.get("provider"))
                emit({"event": "aux_usage", "task": task, "model": getattr(response, "model", ""),
                      "usage": {"inputTokens": u.prompt_tokens, "cachedInputTokens": u.cache_read_tokens,
                      "cacheWriteInputTokens": u.cache_write_tokens, "outputTokens": u.output_tokens,
                      "reasoningOutputTokens": u.reasoning_tokens}})
            real_aux_record(response, task, **kwargs)
        aux_accounting.record_aux_usage = record_aux
        from openai.resources.chat.completions.completions import Completions
        real_create = Completions.create

        def record_request(resource: Any, *args: Any, **kwargs: Any):
            definitions = request_tools(kwargs)
            emit({"event": "api_request", "model": kwargs.get("model"), "toolCount": len(definitions),
                  "toolNames": [t.get("function", {}).get("name") for t in definitions]})
            return real_create(resource, *args, **kwargs)
        Completions.create = record_request
        from run_agent import AIAgent
        agent = AIAgent(provider=runtime["provider"], model=model,
                        base_url=runtime.get("base_url"), api_key=runtime.get("api_key"),
                        api_mode=runtime.get("api_mode"), enabled_toolsets=sorted(toolsets) or [],
                        quiet_mode=True, save_trajectories=False, skip_context_files=True,
                        skip_memory=True, skip_background_review=True, load_soul_identity=False,
                        platform="cli", max_iterations=15, max_tokens=8192,
                        run_budget_seconds=150, cwd=directory)
        agent._skip_mcp_refresh = True
        visible = {t["function"]["name"] for t in agent.tools}
        allowed = {"tool_search", "tool_describe", "tool_call"} if spec["arm"] == "native" else expected
        if visible != allowed:
            raise RuntimeError(f"Fixture tool isolation/assembly mismatch: {sorted(visible)}")
        from dataclasses import asdict
        from tools.tool_search import load_config
        emit({"event": "ready", "metadata": {"commit": commit, "model": model,
              "provider": agent.provider, "apiMode": agent.api_mode, "baseUrl": agent.base_url,
              "toolSearch": asdict(load_config()), "reasoningConfig": agent.reasoning_config,
              "fixtureCount": len(expected), "isolated": True, "auxiliaryUsageObserved": True}, "tools": agent.tools})
        import agent.turn_response_check as response_check
        real_record = response_check.record_response_usage
        from agent.usage_pricing import normalize_usage

        def record_usage(owner: Any, response: Any, **kwargs: Any):
            if getattr(response, "usage", None):
                u = normalize_usage(response.usage, provider=owner.provider, api_mode=owner.api_mode)
                emit({"event": "usage", "usage": {"inputTokens": u.prompt_tokens,
                      "cachedInputTokens": u.cache_read_tokens, "cacheWriteInputTokens": u.cache_write_tokens,
                      "outputTokens": u.output_tokens, "reasoningOutputTokens": u.reasoning_tokens},
                      "apiDurationMs": kwargs["api_duration"] * 1000,
                      "servedModel": getattr(response, "model", "")})
            return real_record(owner, response, **kwargs)
        response_check.record_response_usage = record_usage
        history = None
        started = time.monotonic()
        for prompt in spec["prompts"]:
            result: Json = agent.run_conversation(user_message=prompt, system_message=spec["instructions"],
                                                   conversation_history=history)
            history = result.get("messages") or []
            completed = bool(result.get("completed")) and not bool(result.get("failed") or result.get("interrupted"))
            emit({"event": "turn", "answer": result.get("final_response") or "",
                  "messages": history, "completed": completed,
                  "error": None if completed else str(result.get("turn_exit_reason") or "incomplete"),
                  "elapsedSeconds": time.monotonic() - started})
            if not completed:
                break
        agent.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not serialize HTTP headers, provider client objects or credential tracebacks.
        frames = [{"file": Path(f.filename).name, "line": f.lineno} for f in traceback.extract_tb(error.__traceback__)]
        emit({"event": "error", "error": type(error).__name__, "frames": frames})
        print(f"Benchmark adapter failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
