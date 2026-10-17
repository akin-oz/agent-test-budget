# agent-test-budget

Keep AI-written tests. Cut what they cost.

A Claude Code plugin that makes the write → run → fail → fix loop cheap. The rules are enforced by hooks and inside the test runners themselves, not requested in a prompt, so the agent cannot simply ignore them.

Spend limits (Claude Code's own, or a gateway's) cap what a team may spend; they do not make a task cheaper. This plugin works on the other side: fewer tokens for the same finished change, with the test quality checked so cheaper does not mean weaker.

```text
before:  agent runs `npx vitest run`  → whole suite, full runner output, again and again
after:   agent runs `tbudget run src/cart.test.ts` → "tb: PASS vitest | 8 passed | 1.1s | 1 target"
```

## Install (about 1 minute)

Needs Claude Code and Node 18+ on your PATH.

```bash
claude plugin marketplace add akin-oz/agent-test-budget
claude plugin install agent-test-budget@agent-test-budget
```

Check it works: ask the agent to run `npx vitest run`. It should be refused with a message pointing at `tbudget run`.

Whole team: commit [`templates/team-settings.json`](templates/team-settings.json) as `.claude/settings.json` (merge it into yours). It pins the marketplace to the `v0.1.0` release tag with `"ref"`; change the tag when you upgrade. Teammates are asked to trust the folder; if the plugin does not appear, run `/plugin install agent-test-budget@agent-test-budget` once. For a company rollout, read [Installing for a company](#installing-for-a-company) first.

Optional: `mkdir .test-budget && cp templates/policy.json .test-budget/` and commit it. Defaults work without it.

Team pilot: start in [shadow mode](#pilot-in-shadow-mode-first). Nothing is blocked; you get a week of evidence before deciding.

## Pilot in shadow mode first

Recommended first step for a team. Shadow mode installs the plugin with zero enforcement: the guard denies nothing, the loop breaker and run budget refuse nothing. Each would-be denial or refusal is recorded instead, so after a week you can decide from your own data whether enforcement is worth turning on.

1. Commit `.test-budget/policy.json` with `{ "mode": "shadow" }` (plus any other keys you want).
2. Work as usual for a week.
3. Run `tbudget report`:

   ```text
   tbudget report | mode: shadow | 2026-10-10 09:12 to 2026-10-17 16:40 UTC (7.3 days, 412 records)
   would-deny: 61 | by rule: raw-runner 52, protected 6, rewrite 3
     by agent: main 40, test-writer 21
   would-block: 9 runs | by kind: repeat 7, rate 2 | breaker would have tripped 4x
   tbudget runs: 118 | PASS 81, FAIL 37
   runner output: 812.4k chars raw -> 31.4k chars digest (96% less)
     ~195.3k tokens kept out of context (ESTIMATE: chars/4, not measured token telemetry)
     plus 52 raw runner calls whose full output went to context (size not recorded)
   measured: 23 transcripts (9 subagent) | tokens in 14.2M (cache read 12.9M, write 1.1M), out 310.4k | claude-opus-5-5
     test commands: 38% of all tool output (1.9M of 5.0M chars, 170 calls)
   sessions: 31 started | guard off (TBUDGET_GUARD=off): 2 | in-process guard off: 2
   mutate: 14 runs | mean score 71% of mutants killed
   enforce: set "mode": "enforce" in .test-budget/policy.json
   ```

   (Illustrative numbers.) `tbudget report --json` prints the same numbers as one JSON object (`schema: 1`), so a script can collect them from many repositories. `sessions` counts every session start, including those where someone switched the guard off with `TBUDGET_GUARD=off`: the escape hatch leaves a trace. `would-deny` is what the hook would have refused, with the first 200 characters of each command in `.test-budget/.state/runs.jsonl` so you can check for false positives before anyone gets blocked. `raw-runner-inproc` in that list is a runner the shell guard missed and the [in-process guard](#enforced-inside-the-runners) caught. `would-block` is runs the loop breaker or run budget would have refused. The `~tokens` line is an estimate (characters ÷ 4). The `measured` lines are not: when a session or subagent ends, a hook reads the transcript Claude Code already wrote and records its real API usage, plus how much of all tool output came from test commands. Multiply by your model's prices for dollars.
4. If the numbers justify it and the would-deny commands look right, set `"mode": "enforce"`. If not, uninstall; nothing was blocked in the meantime.

What still happens in shadow mode: `tbudget run` scopes and caps its output as usual (it never blocks anyone). What does not: protected paths are not protected, so the agent could edit the policy or the records. Read the report as evidence, not as an audit.

## Installing for a company

The plugin runs a Node hook on every Bash and file-edit call, with the engineer's permissions. An unpinned install follows this repository's default branch, so whatever is pushed here reaches your machines on the next update. Install from a copy your organization controls, pinned to a release you reviewed. [SECURITY.md](SECURITY.md) lists what the hook runs, reads and writes.

1. **Fork** into your organization (`your-org/agent-test-budget`). Add a tag ruleset that lets only admins create, move or delete `v*` tags, so a pinned tag cannot change under you. Keep the marketplace `name` as is, so the plugin id stays `agent-test-budget@agent-test-budget`.
2. **Review** the release tag. The plugin has no npm dependencies, so the code in the tag is all the code that runs, apart from Node, git and the test runners your projects already use. Each release on GitHub has a `.tar.gz` of the tag and its `.sha256`. `shasum -a 256 -c agent-test-budget-v0.1.0.tar.gz.sha256` proves the tarball is the one CI built from that tag.
3. **Pin to a tag.** Point settings at your fork and the reviewed tag:

   ```json
   "extraKnownMarketplaces": {
     "agent-test-budget": {
       "source": { "source": "github", "repo": "your-org/agent-test-budget", "ref": "v0.1.0" }
     }
   }
   ```

   Put this in the repository's `.claude/settings.json` (as in [`templates/team-settings.json`](templates/team-settings.json)), or in managed settings together with `"enabledPlugins": { "agent-test-budget@agent-test-budget": true }`. From a shell: `claude plugin marketplace add your-org/agent-test-budget#v0.1.0`.
4. **Pin to a commit (optional).** A marketplace source takes `ref` (a branch or tag) but not a commit. To pin a commit, list the plugin in your organization's own marketplace with a `github` plugin source; `sha` wins over `ref`:

   ```json
   {
     "name": "your-org-plugins",
     "owner": { "name": "Your Org" },
     "plugins": [
       {
         "name": "agent-test-budget",
         "source": { "source": "github", "repo": "your-org/agent-test-budget", "ref": "v0.1.0", "sha": "<40-character commit sha>" }
       }
     ]
   }
   ```

   The plugin id is then `agent-test-budget@your-org-plugins`.
5. **Enforce it (optional).** In managed settings, `strictKnownMarketplaces` with `{ "source": "github", "repo": "your-org/agent-test-budget", "ref": "v0.1.0" }` stops engineers adding an unpinned copy. It matches `ref` exactly and blocks every source it does not list, so add your other approved marketplaces to it. See [Manage plugins for your organization](https://code.claude.com/docs/en/plugins/org).

To update:

1. In the fork, fetch the new upstream tag and read the diff: `git fetch upstream --tags && git diff v0.1.0 v0.2.0`. Check `hooks/`, `lib/`, `bin/` and `agents/` against SECURITY.md.
2. Push the reviewed tag to your fork, then change `ref` (and `sha`, if you pin one) in your settings and commit.
3. Engineers run `claude plugin marketplace update agent-test-budget`, then `claude plugin update agent-test-budget@agent-test-budget`, and restart Claude Code. Every release bumps `version` in `plugin.json`, which is what tells Claude Code that the plugin changed.

## Enforced inside the runners

The PreToolUse hook reads each Bash command and refuses raw test runs. A shell parser can always be outrun (a Node script that spawns vitest, a variable set in an earlier call), so the runners check too:

- At session start, a hook appends three exports to Claude Code's `CLAUDE_ENV_FILE`, which runs before every Bash command: `NODE_OPTIONS=--require <plugin>/lib/preload.cjs`, and `PYTHONPATH` / `PYTEST_PLUGINS` for [`python/tbudget_pytest.py`](python/tbudget_pytest.py). They add to your existing values and are added once.
- In every Node process the agent starts, the preload looks at the program being run. For anything but vitest or jest, that is all it does. A vitest or jest started outside `tbudget` exits with code 2 and a pointer to `tbudget run`. The pytest plugin does the same for pytest.
- `tbudget` marks its own runs (`TBUDGET_INSIDE=1`), and the hook refuses an agent command that sets that variable.

Cost: `npm run bench:preload` starts `node -e 0` with and without the preload, interleaved. On an Apple Silicon Mac with Node 26 the median difference was under 0.5 ms on a 32 ms start, within run-to-run noise. Run it on your own machines; slower disks and older Node versions will differ.

It follows the policy: `mode: shadow` only records (`raw-runner-inproc` in the report), `guard.enforce` and `guard.inProcess` switch it off per runner or entirely. It never affects your own terminal.

## Where the tokens go, and what stops each leak

| Leak | What stops it | Enforced by |
|---|---|---|
| Full-suite or unscoped runs | `tbudget run <file>` runs only that file, the tests related to a source file, or the tests related to uncommitted changes. Stops at the first failing test (jest: the first failing file). | Hook denies raw `vitest`, `jest`, `pytest`, `npm test` and the ways around them |
| A pass that prints a screen of output | A pass is one line | CLI |
| A failure that prints thousands of characters | Digest: failing test, message, 2 stack frames, 24 lines max. Full log goes to a file. | CLI |
| Re-running the same failure | 3 identical failures: runs touching it are refused. 12 runs per hour budget. | CLI state, protected by the hook |
| Resending a whole test file to change one line | A Write that is mostly identical to an existing test file is denied; use Edit | Hook |
| The loop filling the main conversation | `test-writer` subagent keeps the write-run-fix loop in its own context and returns an 8-line report | Subagent |
| The agent editing its own limits | Policy, state, `.claude/settings*.json` and the plugin's files are protected. `tbudget reset` is human-only. | Hook |
| A runner started some way the shell guard cannot read (a Node or Python script, a variable from an earlier call) | vitest, jest and pytest refuse to start outside `tbudget` | [In-process guard](#enforced-inside-the-runners) |
| Cheaper tests that catch less | `tbudget mutate <src-file>` plants small bugs and lists the ones no test caught; the subagent runs it once when green | CLI, subagent |

The test-writing itself is untouched: the agent still writes the tests, you still don't.

## Use

Work as usual: "add tests for src/cart.ts". The bundled skill and subagent steer the work. The CLI, if you want it yourself:

```bash
tbudget run src/cart.test.ts            # one file
tbudget run src/cart.test.ts -t "total" # one test (-k works too; sent as -t to vitest/jest, -k to pytest)
tbudget run src/cart.ts                 # tests related to a source file
tbudget run                             # tests related to uncommitted changes
tbudget brief src/cart.ts               # exports + existing tests + one style exemplar
tbudget stats                           # runs, denials, trips, characters kept out of context
tbudget mutate src/cart.ts              # test quality: which small bugs in cart.ts do the tests miss?
tbudget report [--json]                 # what enforcement stopped or would have, measured tokens, escape-hatch use
tbudget reset --reason "flaky CI box"   # human only: clear the loop breaker and run budget
```

A STOP message prints the exact `node <plugin dir>/bin/tbudget reset` command to paste into your own terminal. From 70% of the run budget on, every run says how many are left, so the agent can plan instead of hitting the wall.

`tbudget mutate` makes up to `mutate.maxMutants` small, valid edits to the file (a flipped comparison, `&&` for `||`, an off-by-one constant, a removed `throw`), runs the related tests (or `--tests <files>`) against each, and restores the file. A survivor is a behaviour no test checks. Some survivors are equivalent mutants that no test can kill (`x <= lo ? lo` returns the same value as `x < lo ? lo`); read the list, do not chase 100%. It counts as one run against the budget. It refuses a file with uncommitted changes, because a hard crash mid-run would leave a mutant in the only copy of that work (`--allow-dirty` relies on the backup instead). In CI, set `mutate.minScore` (for example `0.6`) to fail below that score.

The CLI is on the agent's PATH while the plugin is enabled. To use it in your own terminal, run `npm link` in a clone of this repo, or call `node <plugin dir>/bin/tbudget`.

Exit codes: 0 pass, 1 test failure (or zero tests ran), 2 usage or policy refusal, 3 loop breaker or run budget, 4 timeout or runner error.

Runners: vitest, jest, pytest (auto-detected), any tool that writes JUnit XML via `"runner": "junit"`, or any command via `"runner": "generic"` (pass/fail by exit code only). With `junit` or `generic`, the configured command is also blocked when the agent runs it raw (`guard.blockRunnerCmd`).

| Stack | `junit.cmd` | `junit.report` |
|---|---|---|
| Go | `gotestsum --junitfile {report} -- {files}` | (none: `{report}` is used) |
| Gradle | `./gradlew test {name}` | `build/test-results/test` |
| Maven | `mvn -q test` | `target/surefire-reports` |
| Bazel | `bazel test {files}` | `bazel-testlogs` |
| Rust (nextest) | `cargo nextest run --profile ci {files}` | `target/nextest/ci/junit.xml` |

`{files}`, `{name}` and `{report}` are replaced and shell-quoted. A target may be a package or label that is not a file (`./pkg/...`, `//app:test`). A command template has no "tests related to my changes" mode, so `tbudget run` with no targets is refused (`--all` runs the whole command when `allowAll` is on). A report directory only counts XML files written during the run. These rows are starting points; only the parser and the directory handling are tested here, not each tool.

## Policy (`.test-budget/policy.json`)

Human-edited. The guard stops the agent from changing it.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `enforce` | `enforce`, or `shadow` to record what would be denied or refused without blocking anything ([pilot](#pilot-in-shadow-mode-first)). An unknown value falls back to `enforce` with a warning |
| `runner` | `auto` | `auto`, `vitest`, `jest`, `pytest`, `junit`, `generic` |
| `junit.cmd` / `junit.report` | `""` | Command for `runner: junit`, and the JUnit XML file or directory it writes (not needed when the command uses `{report}`) |
| `allowAll` | `false` | Allow `tbudget run --all` (the full suite is normally CI's job) |
| `timeoutSec` | `120` | Kill the runner after this long (1 to 1800) |
| `failFast` | `true` | Stop at the first failing test. jest can only stop after the first failing file (`--bail` counts suites), so a file with several failures still runs to its end |
| `digest.maxLines` | `24` | Hard cap on what the agent sees (8 to 80) |
| `loop.maxAttemptsPerFailure` | `3` | Identical failures before runs touching it are refused |
| `loop.maxRunsPerWindow` / `windowMin` | `12` / `60` | Run budget |
| `loop.ttlMin` | `60` | A trip expires after this many minutes without a repeat |
| `guard.enforce` | vitest, jest, pytest | Runners whose raw use is blocked |
| `guard.blockPatterns` | `[]` | Extra regexes to block, e.g. `["^go test", "^turbo (run )?test"]` |
| `guard.preferEditOverRewrite` | `true` | Deny whole-file rewrites of existing tests |
| `guard.blockRunnerCmd` | `true` | With `junit`/`generic`: block the configured command itself when run raw |
| `guard.inProcess` | `true` | Refuse vitest, jest and pytest inside the process when started outside `tbudget` |
| `mutate.maxMutants` / `minScore` | `12` / `0` | Mutants per `tbudget mutate`; a `minScore` above 0 (0 to 1) makes it exit 1 below that score |
| `measure.transcripts` | `true` | Read each session's transcript when it ends, for the measured token counts (counts only, kept in `.test-budget/.state`). `false` turns it off |

Typos are reported on the first line of `tbudget run` instead of being ignored.

## Tuning the cost

- `agents/test-writer.md` sets `model: inherit` (the session's model) and `maxTurns: 30`. A cheaper model is your call, not the plugin's: set `model: sonnet` or `haiku` there, and check the result with `tbudget mutate`.
- `digest.maxLines` and `loop.*` trade detail against spend.
- `tbudget stats` shows how much runner output stayed out of the conversation.

## Measure it on your own work

I have not published savings numbers, because they depend on your repo, model and tasks. The harness runs the same task with and without the plugin and judges both with the real test runner, outside the agent.

```bash
npm run bench:dry                                              # prints the plan and worst-case spend
node bench/run.mjs --task big-suite --runs 5 --model sonnet --yes  # spends real money
```

Two tasks ship in `bench/tasks/`:

- `slugify-cart`: three small modules without tests. Cheap, but the suite is so small that scoping has little to save.
- `big-suite`: one untested module in a repo with a generated legacy suite (40 files, 1,200 tests, deprecation warnings). An unscoped run prints about 950 lines (~10k tokens), so this is where scoping can show up.

Each run is a full `claude -p` session. Worst case is `runs × arms × --max-budget-usd` (default cap $2; the cap is soft). Arms are interleaved. A run counts only if:

- the whole suite is green,
- the expected test files exist and hold enough passing tests,
- nothing else under `src/` changed (including the existing tests),
- the new tests kill at least 70% of the task's hand-written mutants. Each mutant is one realistic bug in the source; the agent's test files are re-run against each one. This stops a weaker suite from counting as a cheaper win.

Both arms are billed for the same model: the plugin's `test-writer` uses `model: inherit`. Pass `--subagent-model sonnet` (or any model) to measure a cheaper subagent on purpose; the report lists the models billed per arm either way. The report also includes cost per successful run, so a cheap failure is not a win. Results go to `bench/results/` (git-ignored). Fewer than 5 runs per arm is an anecdote.

To check a task without spending anything: `node bench/run.mjs --task <id> --prepare-only` builds the repo and prints its path. Write a reference suite into it, then run `node bench/run.mjs --task <id> --judge <path>`.

## What has been verified

On Claude Code 2.1.301, in real sessions:

- The marketplace flow works: `plugin marketplace add`, then `plugin install agent-test-budget@agent-test-budget` (tested from a local clone at project scope). The plugin also loads from `--plugin-dir`.
- `bin/tbudget` is on the Bash PATH; the skill is picked up automatically.
- A raw `npx vitest run` is denied in the main session under `acceptEdits` and under `bypassPermissions`, and the agent then switches to `tbudget run` on its own.
- The same denial fires inside a subagent (the audit trail records the agent type).
- The `test-writer` subagent runs `tbudget brief`, writes the file once, runs `tbudget run`, and returns a one-line report.

On Claude Code 2.1.299, in a live `claude -p --plugin-dir` session (Haiku, Oct 2026):

- The SessionStart hook's `CLAUDE_ENV_FILE` preamble reaches the Bash tool: `NODE_OPTIONS` carries the preload and `PYTEST_PLUGINS` the pytest plugin.
- `node spawn.mjs`, a Node script that starts vitest (the shell guard only sees `node`), exits 2 with the in-process refusal, and `tbudget run` still passes.
- SessionEnd fires and records the session: `tbudget report` shows the measured Haiku token usage and the in-process denial.

Test suite: 100 unit tests and 3 end-to-end tests against real runners (vitest 2.1.9, 3.2.7 and 5.0.5; jest 30; pytest 9). The CI workflow (unit tests on Node 18 to 24, end-to-end, manifest validation on three Claude Code versions, weekly schedule, and a release job that attaches a tarball and its SHA-256 to each `v*` tag) is included but has not run yet; it starts running once the repo is on GitHub.

Outside a Claude Code session, on macOS with Node 26 (Oct 2026):

- The in-process guard, through the same preamble the SessionStart hook writes: a raw vitest 3 run and a vitest started by a Node script are refused with exit 2; pytest 9.1.1 likewise; `tbudget run` and `--version` still work. The unit tests run it under bash.
- `tbudget mutate` on a real vitest project (8 of 12 mutants killed, survivors were the untested error paths) and a real pytest project; the source file was unchanged afterwards.
- The transcript parser on real Claude Code 2.1.299 transcripts.

Not verified: savings numbers; SubagentStop in a live session (it relies on `agent_transcript_path`, and is skipped without it); the in-process guard and SessionEnd in an interactive session (only `-p` was tested); other agents than Claude Code; PowerShell (it does not run the preamble, so the in-process guard is off there); the JUnit command examples per tool; Windows (bash-style shims); `"onFailure": "block"` on the hook; managed-settings deployment; Claude Code versions other than 2.1.301.

### Support matrix

| | Version | Status |
|---|---|---|
| Claude Code | 2.1.301 | Verified in real sessions (list above) |
| Claude Code | 2.1.299 | `claude plugin validate . --strict` passes; not tested in a session |
| Claude Code | 2.1.292 (npm `stable`), latest | In the CI validation matrix; CI has not run yet |
| Claude Code | anything else | Not verified |
| OS | macOS | Unit tests pass locally |
| OS | Linux (Ubuntu) | CI target for unit, end-to-end and validation; CI has not run yet |
| OS | Windows | Not verified; the CLI shims are bash-style |
| Node | 26 | Unit tests pass locally |
| Node | 18, 20, 22, 24 | In the CI unit matrix (22 also runs end-to-end); CI has not run yet. `engines` requires 18 or later |

## Limits

- **It is not a sandbox.** It stops the reflexive ways of running tests, and many deliberate ones: `npx`/`pnpm`/`yarn`/`bunx` (including workspace options such as `--filter`, `-w`, `--cwd`, `-C`), `python -m`, `uv`/`poetry`/`pipx run`, `uvx`, `hatch test`, `tox`/`nox` (when their config runs pytest), `coverage run -m`, `package.json` scripts, `bash`/`source`/`./script.sh` files, `make` and `just` recipes, `xargs`, `find -exec`, `watch`, wrappers such as `cross-env`, `dotenv`, `caffeinate`, `script` and `xvfb-run`, subshells, `if`/`for`/`case` bodies, `$()`, backticks, `<()`, `$'...'` quoting, variables assigned earlier in the same command, backslash line continuations. Protected paths are matched case-insensitively and through `cd`, globs and `git clean -x`/`git stash -a`; `claude plugin disable` of this plugin and setting `TBUDGET_GUARD` are refused too. The shell guard does not follow a variable set in an earlier Bash call (`npx $R`) or a Node or Python program that spawns a runner; the in-process guard catches those for vitest, jest and pytest. Neither follows `docker`/`ssh` (the container has its own environment), Taskfile, or monorepo task runners. Add those with `guard.blockPatterns`, or use `runner: junit` so the configured command is blocked.
- **Where it writes.** The session hooks record only in projects that already have a `.test-budget/` folder, so a user-wide install does not add one to every repository. A `.test-budget/.state/` folder does appear wherever the agent was refused a raw test run or ran `tbudget`.
- **It is cost control, not security.** An agent set on defeating it can still tamper with things outside the project, such as user-level settings.
- **If the hook cannot start (Node missing), it fails open.** A SessionStart check tells the agent when `node` is not on PATH. The hook does fail closed on an internal error while checking a test command. Claude Code 2.1.295 and later document `"onFailure": "block"` for command hooks; add it to `hooks/hooks.json` if you prefer failing closed (untested here).
- **The loop breaker keys on the failure text** with numbers blurred. A flaky test that fails differently each time will not trip it; the run budget is the backstop.
- Related-test mode needs git. For pytest it maps `foo.py` to `tests/test_foo.py` by naming convention only.
- Other agents (Codex CLI, Cursor, ...): the hooks are Claude Code's, but the in-process guard is plain environment variables. Put the lines from `node <plugin dir>/hooks/session-env.mjs --print` in the shell profile the agent's commands run under, `<plugin dir>/bin` on its PATH, and [`templates/AGENTS.md.snippet`](templates/AGENTS.md.snippet) in its instructions. Then vitest, jest and pytest refuse to run outside `tbudget` there too. Untested with any agent but Claude Code.
- **The in-process guard needs the agent's shell to source the preamble.** `NODE_OPTIONS=` or `env -u NODE_OPTIONS` in front of a command switches it off for that command; the shell guard still sees the runner in that command, but not in a script it calls.

## If something is off

- **`tbudget: command not found`**: the plugin is not enabled in this session (`claude plugin list`), or you are outside Claude Code's Bash tool. Run `node /path/to/bin/tbudget` instead.
- **The guard blocks something legitimate**: narrow `guard.enforce`, or start Claude Code with `TBUDGET_GUARD=off claude` to switch the guard off for that session. The agent cannot set that variable for the hook process.
- **`no test runner detected`**: set `"runner"` in `.test-budget/policy.json`.
- **A STOP from the loop breaker that you want to clear**: paste the `node .../bin/tbudget reset --reason "..."` command from the STOP message into your own terminal. The reason shows up in `tbudget report`. A trip also expires on its own after `loop.ttlMin` minutes.
- **A source file looks mutated**: a `tbudget mutate` run was killed hard. The next `tbudget` command restores it from `.test-budget/.state/mutate-backup.json`.
- **The in-process guard blocks a runner you started yourself inside the agent's session**: it only applies to the agent's Bash tool. Use your own terminal, set `guard.inProcess: false`, or start Claude Code with `TBUDGET_GUARD=off`.

## Layout

```text
.claude-plugin/   plugin.json, marketplace.json
hooks/            hooks.json, guard.mjs (PreToolUse), session-env.mjs (SessionStart), session-end.mjs (SessionEnd, SubagentStop)
python/           tbudget_pytest.py, the in-process guard for pytest
bin/tbudget       the CLI (on the Bash PATH while the plugin is enabled)
lib/              guard rules, runner adapters, digest, loop breaker, mutate, transcript usage, preload.cjs (in-process guard for Node)
agents/           test-writer subagent
skills/tests/     workflow the main agent follows
templates/        policy, team settings, AGENTS.md snippet
bench/            A/B harness and task fixture
test/             unit, end-to-end and fixture projects
```

## License

MIT
