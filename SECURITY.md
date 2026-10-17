# Security

This page is for whoever reviews agent-test-budget before it is installed. It lists what the plugin runs on an engineer's machine, what it reads and writes, and how to report a problem.

## What runs, and when

Everything runs locally, as the engineer's own user, with no extra privileges.

| Component | When it runs | What it executes |
|---|---|---|
| `PreToolUse` hook ([`hooks/hooks.json`](hooks/hooks.json)) | Before every `Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` tool call, in the main session and in subagents | `node ${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs`, with a 10-second timeout |
| `SessionStart` hook | Once per session | `command -v node` (prints a warning if Node is missing), then `node hooks/session-env.mjs`, which appends three `export` lines to the file in `CLAUDE_ENV_FILE` (see [In-process guards](#in-process-guards)) |
| `SessionEnd` and `SubagentStop` hooks | When a session or subagent ends | `node hooks/session-end.mjs`: reads that session's transcript file and appends one record of token counts (see below) |
| In-process guards ([`lib/preload.cjs`](lib/preload.cjs), [`python/tbudget_pytest.py`](python/tbudget_pytest.py)) | At the start of every Node process, and every pytest run, in the agent's Bash tool | One check of the program name; for vitest, jest or pytest started outside `tbudget`, reads the policy, appends an audit record and exits with code 2 |
| `tbudget` CLI ([`bin/tbudget`](bin/tbudget)) | Only when the agent or a person runs `tbudget ...` | See [The CLI](#the-cli) |
| `test-writer` subagent, `tests` skill | When Claude Code picks them | Markdown instructions only. They run no code of their own |

The hook ([`hooks/guard.mjs`](hooks/guard.mjs) and [`lib/guard-core.mjs`](lib/guard-core.mjs)):

- **Starts no processes.** It imports only `node:fs`, `node:path` and `node:url` (plus the plugin's own `lib/` modules, which import nothing else). It parses the command text itself; it never runs the command, a shell, git or a test runner. The same holds for the SessionStart and SessionEnd hooks.
- **Never allows anything.** It either prints a `deny` decision or prints nothing (always nothing in shadow mode), so Claude Code's own permission rules still apply to every call.
- **Fails open if it cannot start** (Node missing), and fails closed on an internal error while checking a test command. The README's [Limits](README.md#limits) section has the details.

## What the hook reads

- The JSON payload Claude Code sends on stdin: tool name, tool input (the Bash command, or the file path and new content), `cwd` and the agent type.
- `.test-budget/policy.json` in the project, if there is one.
- To see through indirection in a Bash command: `package.json` files (the `scripts` field) from the working directory upward and in workspace folders, `Makefile` / `justfile` recipes, and shell scripts the command names (only files up to 256 KB).
- For a `Write` to an existing test file: that file's current content, to detect a near-identical rewrite.
- The environment variables `TBUDGET_GUARD` (set to `off` by a person to disable the guard for a session), `TBUDGET_INSIDE` (set by `tbudget` on its own runner processes; the hook refuses an agent command that sets it) and `TBUDGET_SELFTEST_THROW` (used by the test suite).
- The SessionEnd/SubagentStop hook reads the transcript file Claude Code names in its payload (`transcript_path`, or `agent_transcript_path` for a subagent), up to 200 MB. It keeps counts only: tokens per model from the API usage fields, and character counts of tool output. No message text, tool output or command is stored.

It does not read credentials or user-level Claude Code settings. Outside the project it reads only the plugin's own files and the session transcript described above.

## In-process guards

`session-env.mjs` appends these lines to `CLAUDE_ENV_FILE` (the preamble Claude Code runs before each Bash command in the session); `node hooks/session-env.mjs --print` shows them:

- `NODE_OPTIONS` gains `--require <plugin>/lib/preload.cjs`, so the preload runs at the start of every Node process the agent's shell starts.
- `PYTHONPATH` gains `<plugin>/python`, and `PYTEST_PLUGINS` gains `tbudget_pytest`.

Existing values are kept, and nothing is added twice. The preload and the pytest plugin start no processes and make no network calls. Their only write is one audit record in `.test-budget/.state/runs.jsonl` when they refuse (or, in shadow mode, would refuse) a runner. They catch their own errors and then do nothing, so a bug in them cannot break an unrelated process. Remove them for a session with `TBUDGET_GUARD=off`, or for a project with `"guard": { "inProcess": false }`.

## Network

The plugin makes **no network calls**. No file in `hooks/`, `lib/` or `bin/` imports `http`, `https`, `net`, `dns` or `fetch`, and the hook starts no processes that could. The plugin sends no telemetry.

The plugin has **no npm dependencies** (`package.json` has no `dependencies` field), so installing it pulls in no third-party code.

Two things outside the plugin's runtime can use the network:

- The test runners that `tbudget run` starts (vitest, jest, pytest, or your `generic.cmd`) do whatever your project's tests do.
- The benchmark harness in `bench/` runs `claude -p` sessions, which call the Anthropic API and are billed. It runs only when someone types `node bench/run.mjs` or `npm run bench`; nothing in the plugin starts it.

## What gets written, and where

All writes go under the project root, in `.test-budget/`. The session hooks write only where that folder already exists; the guard and the CLI create it when they first record something:

| Path | Written by | Contents |
|---|---|---|
| `.test-budget/.gitignore` | hook, CLI | `.state/`, so the state directory is not committed |
| `.test-budget/.state/runs.jsonl` | hook, CLI | Audit records: timestamp, rule name, tool, agent type for each denial; runner, status, counts and sizes for each run. In shadow mode (`"mode": "shadow"` in the policy) each would-deny record also keeps the first 200 characters of the Bash command or the file path; otherwise no command text. Never file content. Trimmed to the newest 2,000 records past 1 MB |
| `.test-budget/.state/state.json` | CLI | Loop-breaker state: hashes of recent failures and their counts |
| `.test-budget/.state/last-run.log` | CLI | The full output of the last test run. Tests that print secrets will put them here, as they would in a terminal |
| `.test-budget/.state/errors.log` | hook, CLI | Stack traces of the plugin's own internal errors |
| `.test-budget/.state/runs.jsonl` (session records) | SessionEnd/SubagentStop hook | Per transcript: its path, the session id, token counts per model, tool-output character counts. No content. Off with `"measure": { "transcripts": false }` |
| `.test-budget/.state/runs.jsonl` (session starts) | SessionStart hook | Per session: the session id, whether `TBUDGET_GUARD=off` was set, whether the in-process guard was set up, the OS |
| `.test-budget/.state/mutate-backup.json` | `tbudget mutate` | The full text of the source file being mutated, while the run lasts; deleted at the end. If a run is killed hard, the next `tbudget` command restores the file from it |

The project root is the nearest folder above the working directory that holds `.test-budget/policy.json`, else the nearest one with `.git`, else the working directory. To remove everything the plugin wrote: `rm -rf .test-budget/.state`.

## The CLI

`tbudget` runs only when called. It:

- starts the project's test runner with the file arguments it was given, in the package that owns them, in its own process group, killed after `timeoutSec`: the package's own vitest or jest (through `npx --no-install`, so nothing is downloaded); for pytest, `uv run --frozen pytest` when the package has a `uv.lock` (uv may sync that package's environment, which can download its locked dependencies), else the package's `.venv/bin/pytest`, else `pytest` or `python -m pytest`; or the `generic.cmd`/`junit.cmd` from your policy;
- runs `git status --porcelain` to find uncommitted changes, for `tbudget run` with no files;
- reads source and test files for `tbudget brief`;
- for `tbudget mutate`, rewrites one source file in place with each mutant in turn, runs the tests, and writes the original back (also on Ctrl-C, and from the backup above after a hard kill). It refuses a file with uncommitted changes unless given `--allow-dirty`, so a crash cannot destroy uncommitted work; it runs `git status --porcelain` on that file to check;
- writes only the files listed above.

`generic.cmd` runs through a shell. It comes from `.test-budget/policy.json`, which the hook stops the agent from editing; treat that file like any other committed build script.

## What this plugin is not

It is cost control, not a sandbox. It does not stop a determined agent from running tests some other way, and it does not protect files outside the project. The README's [Limits](README.md#limits) section lists what it does and does not catch.

## Supported versions

Security fixes go into the latest release only. Pin a release tag as described in [Installing for a company](README.md#installing-for-a-company), and upgrade when a fix ships.

## Reporting a vulnerability

Report it privately through GitHub: on [akin-oz/agent-test-budget](https://github.com/akin-oz/agent-test-budget), open the **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Include the Claude Code version, OS, Node version, and the smallest command or tool call that shows the problem. The maintainer aims to reply within 7 days. Fixed issues are credited in the release notes unless you ask otherwise.

Bugs that are not security problems, including ways around the guard that cost tokens but cross no trust boundary, can go in a normal issue.
