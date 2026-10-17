---
name: tests
description: Use when writing, fixing, extending or running automated tests (vitest, jest, pytest). Gives the cost-capped workflow - tbudget for every run, the test-writer subagent for writing - and explains what the hooks block and why.
---

# Cheap, automated tests

A hook blocks raw `vitest`, `jest`, `pytest`, `npm test` and friends in this project. Use these instead:

| Need | Command |
|---|---|
| Write, extend or fix tests | Delegate to the `test-writer` subagent with the source file paths |
| Run one test file | `tbudget run <test-file>` |
| Run a single test | `tbudget run <test-file> -t "<name>"` |
| Run what a source change affects | `tbudget run <src-file>`, or `tbudget run` for all uncommitted changes |
| Learn a file before testing it | `tbudget brief <src-file>` (exports, existing tests, one style exemplar) |
| Check the tests catch bugs | `tbudget mutate <src-file>` (plants small bugs; lists the ones no test caught) |
| See what was saved | `tbudget stats` |

## What you get back

- Pass: one line. Nothing else to read.
- Failure: a digest of the failing test, its assertion message and two stack frames, capped by `digest.maxLines` in `.test-budget/policy.json`.
- The full output of the last run is `.test-budget/.state/last-run.log`. Open it only when the digest is not enough.
- Exit codes: 0 pass, 1 test failure, 2 usage or policy refusal, 3 loop breaker or run budget, 4 timeout or runner error.

## Rules

1. Scope every run to the files you touched. The full suite is CI's job; `--all` is off unless the policy turns it on.
2. Never re-run an unchanged failing test. Each run must follow a real edit.
3. Existing test files change through Edit hunks. A whole-file Write over a mostly identical test file is blocked.
4. When `tbudget` prints STOP (the same failure three times, or the run budget used up), stop. Report the failing test, the error and your best hypothesis to the user. Do not try to get around the limit; the policy and state files are protected on purpose.
5. Do not weaken assertions, delete tests or add skips to reach green. If the code under test looks wrong, say so.
6. Green is not the finish line: run `tbudget mutate <src-file>` once and cover the survivors that matter. Cheaper tests that catch less are not a saving.
