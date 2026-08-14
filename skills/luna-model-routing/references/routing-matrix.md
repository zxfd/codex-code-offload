# Model Routing Matrix

Choose one primary route from the evidence type and required operation. The current model coordinates; this matrix does not assert or change its model identity or reasoning effort.

## Primary selection

| Condition | Primary route | Default | Coordinator boundary |
|---|---|---|---|
| Read active rules, triggered Skill instructions, or required Skill references | `local_exec` | current task | control context only |
| Inspect paths, Git state, sizes, hashes, manifest keys, installed roots, or test names | `local_exec` | current task | metadata only; do not emit task evidence |
| Apply an exact user-supplied single-file replacement that needs no contextual judgment | `current_write` | current task | mechanical exception; stop if surrounding behavior matters |
| Understand, search, trace, or correlate source before a code change | `analysis_thread -> current_write` | `gpt-5.6-luna`, `medium` | Thread reads once; coordinator writes from verified `edit_spec` |
| Analyze text-only logs, documents, reports, transcripts, or database evidence | `analysis_thread` | `gpt-5.6-luna`, `medium` | coordinator may packetize, wait, and verify only |
| Analyze architecture, a difficult root cause, security-sensitive evidence, or context beyond a verified internal budget | `browser_adapter` or `web_llm_thread` | configured Provider | Web-LLM is free-first |
| Analyze images, screenshots, visual OCR, layout, charts, or pixel-dependent meaning | `browser_adapter` or `web_llm_thread` | configured multimodal Provider | never claim a text-only model saw pixels |
| Single explicit `http`/`https` URL that requires opening a fresh Chrome task tab | `url_preingest -> browser_adapter` | local pre-ingest, then one approved named Provider | health check and no-transfer receipt first |
| Run deterministic formatting, tests, hashes, Git checks, or installed-state checks | `local_exec` | current task | route long failure interpretation if analysis is needed |

Classify by output, not tool name. A broad `rg`, file preview, script, query, or browser command that reveals evidence belongs to the evidence route even though the command itself is deterministic.

The code path is deliberately split:

```text
analysis_thread owns source discovery and behavioral reasoning
  -> verified edit_spec
  -> current_write owns focused implementation
  -> local_exec owns deterministic checks
```

Do not let `current_write` expand into source discovery. If the edit needs an uncited file, symbol, behavior, or failure explanation, continue the original analysis Thread once.

## Fallbacks

Record every transition under the same `route_id`:

| Failure | Next route | Limit |
|---|---|---|
| Medium analysis Thread is rejected, unavailable, or cannot accept the packet | eligible Web-LLM Provider chain | coordinator must not take over substantive analysis |
| URL health check fails | `blocked` | no Chrome or Provider call |
| URL pre-ingest returns `requires_user_approval` | same route after approval | no automatic fallback |
| Approved named URL Provider fails | `blocked` pending fresh named-provider approval | previous approval cannot select another Provider |
| Every eligible Web-LLM text Provider fails | `v4_fallback_thread` | one V4 Pro attempt per serial route or parallel branch |
| Every eligible Web-LLM visual Provider fails | `blocked` | V4 Pro is text-only |
| V4 Pro fallback fails | exact mechanical current-model remainder or `blocked` | no renewed analysis takeover and no re-entry to Web-LLM |
| Focused verification disproves a receipt | original route continuation | one bounded follow-up for the concrete conflict |

V4 Pro is never a primary reasoning route and is not a default verifier.

## Parallelism

Default to serial. Use parallel branches only when all are true:

- there are at least two independent scopes or questions;
- branches have no same-file write conflict;
- each branch has one acceptance artifact;
- the expected latency benefit exceeds coordination cost.

Create one Web-LLM Thread shell per independent Web-LLM branch. Keep the configured Provider chain sequential inside that branch. Do not open one Thread per Provider or run identical panels.

Use a serial producer-to-verifier chain only when one specific falsifiable claim remains after focused local checks. A verifier receives the conclusion, minimum evidence, diff or test result, and one to three questions, not the full original input.

## Model and effort guidance

- Coordinating Agent: keep the current model and current effort unless an outer instruction explicitly changes them. Do not announce it as a fixed model role.
- Medium analysis Thread: use `gpt-5.6-luna` with `thinking: medium` exactly and keep it read-only.
- Web-LLM: use the configured Provider model and strength policy; do not substitute an unconfigured model.
- V4 Pro fallback: use `high` normally and `max` only when error cost or reasoning depth warrants it, after Web-LLM exhaustion.
