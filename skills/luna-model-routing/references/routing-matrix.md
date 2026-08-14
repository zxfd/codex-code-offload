# Luna Model Routing Matrix

Luna makes the decision. The matrix chooses a primary route; it is not a command to call every row.

## Primary selection

| Condition | Primary route | Default thinking | Notes |
|---|---|---|---|
| Deterministic command, exact patch, test, formatter, metadata | `local_exec` | n/a | Never delegate merely because the task is long. |
| Text-only bounded coding, low risk, speed-sensitive | `codex_thread` | Spark `medium` | Prefer Spark's separate extra quota when Luna has decided an internal Thread is worthwhile; quota alone does not justify delegation. |
| Text-only long logs/docs/source, triage or evidence extraction | `codex_thread` | V4 Flash `high` | Prefer for context-heavy, lower-risk synthesis. |
| Text-only architecture, difficult root cause, security, high risk | `web_llm_thread` | Provider configured | This replaces the former V4 Pro primary route; Luna verifies before edits. |
| Image, screenshot, visual OCR, layout, chart, or pixel-dependent meaning | `browser_adapter` or `web_llm_thread` for a parallel branch | Provider configured | Do not send to text-only internal models. |
| Internal context exceeds safe verified budget or external independent opinion is required | `browser_adapter` or `web_llm_thread` for a parallel branch | Provider configured | Keep large raw context out of Luna. |

## Fallbacks

Use a single direction and record every transition:

| Failure | Serial text route | Parallel route |
|---|---|---|
| Spark unavailable/rejected | Luna or Web-LLM by task size | Luna decides replacement |
| V4 Flash unavailable | Web-LLM, then V4 Pro only if Web-LLM fully fails | Luna decides replacement |
| Web-LLM text Providers all fail | One V4 Pro Thread attempt | One V4 Pro fallback Thread per failed branch |
| Web-LLM visual Providers all fail | `blocked`; V4 Pro cannot see pixels | `blocked` unless local visual proof exists |
| V4 Pro fallback fails | Luna takeover only within verified safe budget, otherwise `blocked` | Same per branch |

The only V4 Pro entry for a text reasoning route is `Web-LLM Providers all fail -> one V4 Pro Thread`. This applies to a serial route and independently to each parallel Web-LLM branch. It must not re-enter Web-LLM after V4 Pro fails.

## Parallelism

Default to serial. Allow parallel dispatch only when Luna can state:

- at least two independent scopes or questions;
- no same-file write conflict;
- each branch has one acceptance artifact;
- a declared reason parallel completion is worth the coordination cost.

For verifier chains, use serial `producer -> focused verifier` only when the verifier needs the producer output and a concrete claim remains unresolved. The verifier packet contains the conclusion, minimum evidence, diff/test result, and focused questions; it is not a second full-input analysis. Do not parallelize identical full-input analyses merely to spend Spark or another model's quota.

When parallelism is justified and a branch selects Web-LLM, create one new Codex App Thread per branch. The Thread is the communication shell; its Browser Adapter Provider chain is still sequential and free-first.

## Reasoning guidance

- Spark: `medium` default; `high` only for bounded coding with objective tests. Its separate extra quota makes it the preferred internal route for eligible low-risk text work, but never the final authority for high-risk decisions.
- V4 Flash: `low` for simple triage, `high` for long-text correlation.
- V4 Pro: `high` for the normal paid fallback, `max` only when the error cost or reasoning depth warrants it; never select it before the branch's Web-LLM chain is exhausted.
- Web-LLM: use the configured Provider model/strength policy; do not substitute an unconfigured model.
