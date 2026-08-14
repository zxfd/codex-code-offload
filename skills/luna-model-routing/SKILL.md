---
name: luna-model-routing
description: Coordinate task routing from a fixed GPT-5.6-Luna main Agent to Codex App model Threads for GPT-5.3-Codex-Spark, DeepSeek V4 Flash, and DeepSeek V4 Pro, plus the existing browser-based Web-LLM adapter. Use when a task needs model selection, internal model communication, Web-LLM offload, unified task receipts, or the non-parallel Web-LLM-to-V4-Pro fallback.
---

# Luna Model Routing

Use the current Luna task as the sole coordinator. Reuse the Codex App Thread communication lifecycle—create a Thread, send a self-contained packet, read or wait for the result, optionally ask once, then return the receipt to Luna—but do not inherit another Skill's model allowlist, worker limits, or fallback policy.

## Invariants

- Keep the main Agent on `gpt-5.6-luna` when this Skill is active. Do not silently switch the main Agent.
- Luna owns classification, model selection, task packets, fallback decisions, integration, verification, edits, tests, and delivery.
- Spark has a separate extra quota. When Luna has already decided that a bounded internal Thread is worthwhile, prefer Spark for eligible low-risk text work before spending Web-LLM capacity; quota alone is never a reason to delegate deterministic work.
- Use Codex App Threads for internal models only: `gpt-5.3-codex-spark`, `deepseek-v4-flash-deepseek`, and `deepseek-v4-pro-deepseek`.
- Use the existing `agentchat-code-offload` Browser Adapter for Web-LLM. Do not represent a Web-LLM Provider as a Codex Thread or put internal models in `providers.json`.
- Workers do not create more Workers, publish, send, delete, pay, change accounts, or perform production actions.
- Treat every Worker and Web-LLM answer as evidence. Luna must verify it against local facts before edits or execution.

## Route once, then communicate

1. Estimate input size, modality, risk, expected output, and whether the task is `serial` or `parallel`.
2. Keep deterministic work in the current Luna task: commands, tests, formatting, exact patches, metadata, hashes, and direct lookups.
3. Select one primary route from [routing-matrix.md](references/routing-matrix.md). Do not call every model as a panel.
4. Build the packet and receipt fields from [communication-contract.md](references/communication-contract.md).
5. For an internal route, use the Codex App Thread lifecycle. For Web-LLM, use the fixed Browser Adapter lifecycle.
6. Read the result into the current Luna task, verify focused claims locally, and decide whether to accept, ask once, fall back, or stop.
7. Make changes and run tests from the current Luna task. A Worker may prepare a patch in its owned scope, but Luna owns final integration.

## Internal Thread transport

Use the Codex App model-Thread tools, not native `spawn_agent`: `codex_app__list_projects`, `codex_app__create_thread`, `codex_app__send_message_to_thread`, `codex_app__read_thread`, `codex_app__wait_threads`, and `codex_app__set_thread_archived`.

1. Locate the matching project when a Worker needs a workspace.
2. Create one Thread with an explicit model, thinking level, complete packet, and target project.
3. Confirm the returned real `thread_id`/`host_id` and readable turn state immediately. An empty ID, timeout, or client-only ID is not a Worker.
4. Record `thread_id`, `model`, `thinking`, `route_id`, owner, and status.
5. Use `wait_threads` for bounded progress snapshots. Use `read_thread` for the final result.
6. If the result is directionally useful but incomplete, ask once in the original Thread. Do not silently repack the task as a new model call.
7. Luna verifies the result and marks `verification_state` before accepting it.

Use these internal model roles:

- Spark: fast, text-only, low-risk coding or bounded verification. Prefer `medium`; use `high` only when the result has objective local checks.
- V4 Flash: fast, text-only long-context triage, log correlation, document/source summarization, and evidence extraction.
- V4 Pro: deep, text-only architecture, difficult root cause, security-sensitive reasoning, and the serial fallback after all Web-LLM text Providers fail.

If the runtime rejects an explicit model or thinking combination, record the rejection and follow the route matrix. Do not omit the thinking field or silently substitute an unconfigured model.

## Web-LLM transport

Keep Web-LLM in the current Luna task while its fixed Browser Adapter uses a connected Chrome Provider tab.

- Pack only task-scoped literal files through `codex-agentchat-offload.mjs`.
- Keep large packed context out of Luna; return only the bounded external conclusion and receipt.
- Use `runProviderFallback` and the configured sequential Provider chain. Do not manually inspect DOM or invent selectors.
- Preserve the existing text and multimodal attachment/readiness rules, `request_id`, context continuation, health cache, and Provider-local failure handling.
- A text-only internal model must never be claimed to have seen an image. If a visual task's Web-LLM route fails, mark it blocked unless Luna has an independently valid local visual result.

### Required serial fallback

For `execution_mode: serial` and a text-only task:

```text
primary internal route or Web-LLM route
  -> configured Web-LLM Provider fallback, when Web-LLM is selected
  -> one V4 Pro Codex Thread attempt if every Web-LLM text Provider fails
  -> Luna takeover only when the remaining input fits a verified Luna-safe budget
  -> blocked with evidence if no safe route remains
```

The Web-LLM-to-V4-Pro fallback is not valid for a pixel-dependent visual/OCR task. V4 Pro is text-only and cannot replace missing visual evidence.

For `execution_mode: parallel`, do not automatically create a V4 Pro replacement when one branch fails. Return the failed branch receipt to Luna; Luna decides whether a replacement is justified by the task ledger and acceptance dependency.

## Verification and execution

- `unverified`: result received but not checked.
- `needs_more_context`: result requests an allowed bounded continuation.
- `verified`: Luna checked the relevant claim or artifact locally.
- `rejected`: result conflicts with local evidence or violates the packet.
- `blocked`: no safe route or required modality remains.

Never move to editing or external execution while a required result is `unverified`, `rejected`, or `blocked`.

For high-risk work, use one explicit verifier route after the primary result when independent evidence is useful. Do not replace local evidence with a vote between models.

## Direct references

- Read [communication-contract.md](references/communication-contract.md) for packet, transport, receipt, and lifecycle fields.
- Read [routing-matrix.md](references/routing-matrix.md) for route selection, reasoning levels, and fallback rules.
