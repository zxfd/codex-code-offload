# Luna Model Routing Matrix

Luna makes the decision. The matrix chooses a primary route; it is not a command to call every row.

## Primary selection

| Condition | Primary route | Default thinking | Notes |
|---|---|---|---|
| Deterministic command, exact patch, test, formatter, metadata | `local_exec` | n/a | Never delegate merely because the task is long. |
| Text-only bounded coding, low risk, speed-sensitive | `codex_thread` | Spark `medium` | Prefer Spark's separate extra quota when Luna has decided an internal Thread is worthwhile; quota alone does not justify delegation. |
| Text-only long logs/docs/source, triage or evidence extraction | `codex_thread` | V4 Flash `high` | Prefer for context-heavy, lower-risk synthesis. |
| Text-only architecture, difficult root cause, security, high risk | `codex_thread` | V4 Pro `high` or `max` | Luna verifies before edits. |
| Image, screenshot, visual OCR, layout, chart, or pixel-dependent meaning | `browser_adapter` | Provider configured | Do not send to text-only internal models. |
| Internal context exceeds safe verified budget or external independent opinion is required | `browser_adapter` | Provider configured | Keep large raw context out of Luna. |

## Fallbacks

Use a single direction and record every transition:

| Failure | Serial text route | Parallel route |
|---|---|---|
| Spark unavailable/rejected | Luna or V4 Flash by task size | Luna decides replacement |
| V4 Flash unavailable | V4 Pro, then Web-LLM if needed | Luna decides replacement |
| V4 Pro unavailable | Web-LLM if the task is eligible | Luna decides replacement |
| Web-LLM text Providers all fail | One V4 Pro Thread attempt | No automatic replacement |
| Web-LLM visual Providers all fail | `blocked`; V4 Pro cannot see pixels | `blocked` unless local visual proof exists |
| V4 Pro fallback fails | Luna takeover only within verified safe budget, otherwise `blocked` | Luna decides |

The special `Web-LLM -> V4 Pro` fallback applies only to `execution_mode=serial` and text-only work. It must not re-enter Web-LLM after V4 Pro fails.

## Parallelism

Default to serial. Allow parallel dispatch only when Luna can state:

- at least two independent scopes or questions;
- no same-file write conflict;
- each branch has one acceptance artifact;
- a declared reason parallel completion is worth the coordination cost.

For verifier chains, use serial `producer -> verifier` when the verifier needs the producer output. Do not parallelize identical full-input analyses merely to spend Spark or another model's quota.

## Reasoning guidance

- Spark: `medium` default; `high` only for bounded coding with objective tests. Its separate extra quota makes it the preferred internal route for eligible low-risk text work, but never the final authority for high-risk decisions.
- V4 Flash: `low` for simple triage, `high` for long-text correlation.
- V4 Pro: `high` for normal deep analysis, `max` only when the error cost or reasoning depth warrants it.
- Web-LLM: use the configured Provider model/strength policy; do not substitute an unconfigured model.
