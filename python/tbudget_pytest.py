"""pytest plugin for the agent's shell (PYTEST_PLUGINS=tbudget_pytest, set by the SessionStart hook).

A pytest started outside `tbudget run` is refused inside the process, however the shell command was
spelled. tbudget sets TBUDGET_INSIDE=1 for its own runs. It never raises on its own errors.
"""
import json
import os
import time


def _root(start):
    for marker in (os.path.join(".test-budget", "policy.json"), ".git"):
        d = os.path.abspath(start)
        while True:
            if os.path.exists(os.path.join(d, marker)):
                return d
            up = os.path.dirname(d)
            if up == d:
                break
            d = up
    return os.path.abspath(start)


def _verdict(args):
    """None to let pytest run, else 'deny' or 'would-deny'."""
    if os.environ.get("TBUDGET_INSIDE") == "1" or os.environ.get("TBUDGET_GUARD") == "off":
        return None
    root = _root(os.getcwd())
    policy = {}
    try:
        with open(os.path.join(root, ".test-budget", "policy.json"), encoding="utf-8") as f:
            policy = json.load(f) or {}
    except Exception:
        pass
    guard = policy.get("guard", {}) if isinstance(policy, dict) else {}
    if guard.get("blockRawRunners") is False or guard.get("inProcess") is False:
        return None
    if "pytest" not in guard.get("enforce", ["vitest", "jest", "pytest"]):
        return None
    kind = "would-deny" if policy.get("mode") == "shadow" else "deny"
    try:
        st = os.path.join(root, ".test-budget", ".state")
        os.makedirs(st, exist_ok=True)
        rec = {"ts": int(time.time() * 1000), "type": kind, "rule": "raw-runner-inproc", "tool": "process",
               "agent": "in-process", "command": " ".join(["pytest", *args])[:200]}
        with open(os.path.join(st, "runs.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
    except Exception:
        pass
    return kind


def pytest_configure(config):
    try:
        if config.getoption("help", False) or config.getoption("version", False):
            return
        verdict = _verdict([str(a) for a in config.invocation_params.args])
    except Exception:
        return
    if verdict == "deny":
        import pytest
        pytest.exit("tb-guard: raw pytest blocked inside the process (it was started outside tbudget). "
                    "Run: tbudget run [test-file ...]", returncode=2)
