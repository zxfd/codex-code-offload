# Luna Model Routing Matrix

Luna makes the decision. The matrix chooses a primary route; it is not a command to call every row.

## Primary selection

| Condition | Primary route | Default thinking | Notes |
|---|---|---|---|
| Deterministic command, test, formatter, metadata-only operation | `local_exec` | n/a | Never delegate merely because the task is long. |
| Text-only coding, implementation, or repair, including patch application and bounded refactors | `current_luna` | Luna Max | Use the current `gpt-5.6-luna` task at `max` for code-modifying text work; do not create a coding Worker Thread. |
| Text-only long logs/docs/source, triage or evidence extraction | `codex_thread` | Luna Medium (`gpt-5.6-luna`, `medium`) | Create a separate explicit Luna Medium Thread. The coordinator may classify, packetize, await, and verify only; it must not perform this route's substantive analysis. |
| Text-only architecture, difficult root cause, security, high risk | `web_llm_thread` | Provider configured | This replaces the former V4 Pro primary route; Luna verifies before edits. |
| Single explicit `http`/`https` URL that requires opening a fresh Chrome task tab | `web_llm_thread` | Provider configured | Mandatory pre-ingest via `ingestSingleUrlWithLocalContext`; default no transfer (`allowExternalTransfer=false`) until explicit approval; execute only the approved named provider once per invocation. |
| Image, screenshot, visual OCR, layout, chart, or pixel-dependent meaning | `browser_adapter` or `web_llm_thread` for a parallel branch | Provider configured | Do not send to text-only internal models. |
| Internal context exceeds safe verified budget or external independent opinion is required | `browser_adapter` or `web_llm_thread` for a parallel branch | Provider configured | Keep large raw context out of Luna. |

For Luna Max coding routes, treat implementation source as single-owner context: Luna reads and changes the code in the current task, then validates only the diff and targeted checks. A second full analysis is not an acceptance step.

For Luna Medium routes, treat the delegated long-context material as single-owner context: the separate Luna Medium Thread reads, correlates, summarizes, or extracts the evidence. The coordinator receives only its bounded receipt and performs focused acceptance checks; it must not take over the substantive analysis while the route is active.

## Fallbacks

Use a single direction and record every transition:

| Failure | Serial text route | Parallel route |
|---|---|---|
| Luna Max unavailable or cannot fit the verified safe budget | Web-LLM by task size | Luna decides replacement |
| Luna Medium unavailable/rejected | Web-LLM, then V4 Pro only if Web-LLM fully fails; never take over in the coordinator task | Luna decides replacement and records the Thread rejection |
| URL pre-ingest blocks or `requires_user_approval` | same route | no route change | stop for user approval; do not auto-fallback or reuse provider attempts without explicit approval |
| Named Provider failure on approved URL page attempt | same route | no route change | block before fallback and request a fresh named-provider approval |
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

For verifier chains, use serial `producer -> focused verifier` only when the verifier needs the producer output and a concrete claim remains unresolved. The verifier packet contains the conclusion, minimum evidence, diff/test result, and focused questions; it is not a second full-input analysis. Do not parallelize identical full-input analyses merely to spend model quota.

When parallelism is justified and a branch selects Web-LLM, create one new Codex App Thread per branch. The Thread is the communication shell; its Browser Adapter Provider chain is still sequential and free-first.

## Reasoning guidance

- Luna Max: `max` default for coding, implementation, repair, and bounded verification in the current task; do not create a coding Worker Thread.
- Luna Medium: `medium` only, as an explicit separate `gpt-5.6-luna` Codex Thread for long-text triage, correlation, summarization, and evidence extraction. The coordinator must not substitute its own analysis for this route.
- V4 Pro: `high` for the normal paid fallback, `max` only when the error cost or reasoning depth warrants it; never select it before the branch's Web-LLM chain is exhausted.
- Web-LLM: use the configured Provider model/strength policy; do not substitute an unconfigured model.
