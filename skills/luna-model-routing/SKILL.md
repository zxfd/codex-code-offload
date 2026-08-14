---
name: luna-model-routing
description: Coordinate free-first task routing from a fixed GPT-5.6-Luna main Agent to Web-LLM through Codex App Threads, with GPT-5.3-Codex-Spark, DeepSeek V4 Flash, and DeepSeek V4 Pro as explicit internal routes. Use when a task needs model selection, cross-model communication, Web-LLM offload, unified task receipts, or the serial/parallel-branch Web-LLM-to-V4-Pro fallback.
---

# Luna Model Routing

Use the current Luna task as the sole coordinator. Reuse the Codex App Thread communication lifecycle—create a Thread, send a self-contained packet, read or wait for the result, optionally ask once, then return the receipt to Luna—but do not inherit another Skill's model allowlist, worker limits, or fallback policy. Treat free Web-LLM capacity as the default for work that would otherwise require V4 Pro.

## Invariants

- Keep the main Agent on `gpt-5.6-luna` when this Skill is active. Do not silently switch the main Agent.
- Luna owns classification, model selection, task packets, fallback decisions, verification, integration, and delivery. Direct code edits are not the default role in Luna.
- For any coding, implementation, or code-repair scope—including patch application, refactors, and deterministic edits—create a `codex_thread` with `gpt-5.3-codex-spark` first (`medium`), then escalate to `high` only for bounded objective checks.
- Keep deterministic local work (`commands`, `tests`, formatting, metadata, hashes, and direct reads) in `local_exec`; do not use this exception for code edits.
- Spark has a separate extra quota and is the default internal route for coding/repair work; quota alone is never a reason to delegate deterministic non-code work.
- Use Codex App Threads for internal models: `gpt-5.3-codex-spark`, `deepseek-v4-flash-deepseek`, and `deepseek-v4-pro-deepseek`.
- Use the existing `agentchat-code-offload` Browser Adapter for Web-LLM. A Web-LLM Thread is only a Codex App communication/workflow shell; its answer source remains the Browser Adapter Provider, never the Thread's Codex model, and internal models do not enter `providers.json`.
- Web-LLM is primary for the architecture, difficult-root-cause, security-sensitive, and other tasks that the old routing would have sent directly to V4 Pro. V4 Pro is a paid fallback only.
- Workers do not create more Workers, publish, send, delete, pay, change accounts, or perform production actions.
- Treat every Worker and Web-LLM answer as evidence. Luna must verify it against local facts before edits or execution.

### Browser Adapter entry resolution

- Resolve the Browser Adapter entry from the plugin cache root, not by appending `skills/control-in-app-browser` to any Skill directory.
- The expected one-shot entry shape is `${HOME}/.codex/plugins/cache/openai-bundled/browser/<version>/scripts/browser-client.mjs`; verify the file exists before runtime use.
- For repository workflows, use `skill/scripts/browser-client-entry.mjs` and retain the resolved absolute path in the route receipt.

### Token-lean Spark handoff

- For code-changing tasks, Spark is the single owner of source-level implementation context. Luna must not reread the complete original source set or redo the design after Spark returns.
- Spark returns only a bounded receipt: `changed_files`, `diff_stat`, `artifact_ref` or worktree path, `tests_run`, `test_result`, `unresolved`, and one short implementation summary. Full source and full patch stay in the artifact/worktree.
- Luna's acceptance pass is local and narrow: inspect the receipt, `git status --short`, `git diff --stat`, `git diff --check`, changed hunks, and the smallest relevant test output. This is integration evidence, not a second implementation analysis.
- Do not create a second verifier or resend the original packet by default. Only send a bounded failure tail and the exact unresolved claim back to the same Spark Thread when local checks fail or a specific falsifiable risk remains.
- If the receipt is complete and focused checks pass, mark it `verified` and integrate once; do not ask Spark to restate source or repeat passed tests.

## Route once, then communicate

1. Estimate input size, modality, risk, expected output, and whether the task is `serial` or `parallel`.
2. Keep deterministic work in the current Luna task: commands, tests, formatting, metadata, hashes, and direct reads; code changes go through the designated Spark Thread.
3. Select one primary route from [routing-matrix.md](references/routing-matrix.md). Do not call every model as a panel.
4. Build the packet and receipt fields from [communication-contract.md](references/communication-contract.md).
5. For an internal route, use the Codex App Thread lifecycle. For Web-LLM, use the fixed Browser Adapter lifecycle; when the task is parallel, create one new Codex App Thread per independent Web-LLM branch and run that branch's Provider chain inside it.
6. Read the result into the current Luna task, verify focused claims locally, and decide whether to accept, ask once, fall back, or stop.
7. Make code changes in the designated Spark Thread; Luna applies or integrates the returned patch only after focused local verification and runs the tests from the current task.

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
- V4 Pro: text-only paid fallback for a serial task or parallel branch whose entire eligible Web-LLM Provider chain has failed. It is not a primary route for Pro-class reasoning.

If the runtime rejects an explicit model or thinking combination, record the rejection and follow the route matrix. Do not omit the thinking field or silently substitute an unconfigured model.

## Web-LLM transport

Use the fixed Browser Adapter with a connected Chrome Provider tab. A serial route may run the adapter from the current Luna task when no delegated Thread is needed. A parallel route must create a separate Codex App Thread for every independent Web-LLM branch; that Thread owns the packet, adapter call, bounded continuation, and receipt for its branch.

- Pack only task-scoped literal files through `codex-agentchat-offload.mjs`.
- Keep large packed context out of Luna; return only the bounded external conclusion and receipt.
- If the Codex App requires a model for a Web-LLM workflow Thread, use the configured Luna host only as the adapter orchestrator; set `model_source=web_provider` and never accept the host model's prose as the Web-LLM result.
- Use `runProviderFallback` and the configured sequential Provider chain. Do not manually inspect DOM or invent selectors.
- Preserve the existing text and multimodal attachment/readiness rules, `request_id`, context continuation, health cache, and Provider-local failure handling.
- The Provider chain remains sequential inside each Web-LLM Thread. Do not open one Thread per Provider or turn the configured fallback chain into a model panel.
- A text-only internal model must never be claimed to have seen an image. If a visual task's Web-LLM route fails, mark it blocked unless Luna has an independently valid local visual result.

### Required serial fallback

For `execution_mode: serial` or for each independent `execution_mode: parallel` branch, when the selected route is text-only Web-LLM:

```text
Web-LLM Provider chain (inside the current task or that branch's new Web-LLM Thread)
  -> one V4 Pro Codex Thread attempt if every Web-LLM text Provider fails
  -> Luna takeover only when the remaining input fits a verified Luna-safe budget
  -> blocked with evidence if no safe route remains
```

The Web-LLM-to-V4-Pro fallback is per serial route or per parallel branch, and is allowed only after that route's configured Provider chain has no accepted result. V4 Pro is text-only and cannot replace missing visual evidence or a failed multimodal route.

For `execution_mode: parallel`, every independent branch starts with its own Web-LLM Thread. If that branch exhausts Web-LLM, create at most one V4 Pro fallback Thread for that branch; do not create V4 Pro preemptively or retry V4 Pro a second time.

### Mandatory URL ingestion gate for new Chrome tasks

For any fresh Luna task that is based on one explicit user-approved `http`/`https` URL and requires opening a new Chrome tab:

- run the generic pre-ingestion helper first: `ingestSingleUrlWithLocalContext` from `skill/scripts/web-ingest.mjs`;
- treat it as mandatory and never replace it with ad-hoc DOM/text/screenshot extraction in this route;
- keep the accepted processing-policy shape to only these fields:

```text
{
  allowText: true,
  allowVisual: true,
  allowExternalTransfer: false,
  maxImages: 4,
}
```

- always default with `allowExternalTransfer: false`, so the function should return `status: requires_user_approval` with a bounded receipt and **must not call any provider** until explicit re-approval.
- do not accept URL lists, wildcard URLs, commas/spaces, or redirects that change origin; reject those as bounded route blocks before transfer;
- never reuse an existing provider tab for this pre-ingest step; use a newly opened Chrome task tab and keep receipt-only continuation with `request_id`.

A fresh-task execution must follow this two-step route:

1. Invoke `ingestSingleUrlWithLocalContext(..., { allowExternalTransfer: false, ... })`.
   - This step owns local extraction, capture, sanitization, and bounded receipt creation.
2. If the status is `requires_user_approval`, request explicit user approval for the specific action and the named provider.
3. After explicit approval, invoke `ingestSingleUrlWithLocalContext` again with `allowExternalTransfer: true` and a wrapped/overridden `runProvider` that routes to exactly one **named provider only**.

Luna must treat the ingestion receipt as bounded evidence: text previews, signal counts, modality, risk levels, provider/model, attachments readiness, and error/blocked reason. Raw DOM, page body, OCR text, screenshots, query tokens, cookies/storage, and arbitrary UI diagnostics must never enter Luna/tool output. `ingestSingleUrlWithLocalContext` owns all temporary `prompt.txt` and image artifacts internally; Luna receives only a bounded final receipt and must not expose reusable temporary paths.

Named-provider approval boundary:

- If the named provider returns failure for the same page data, Luna must stop and request a fresh named-provider approval step.
- Do not retry another provider, and do not auto-run the configured fallback chain after that failure.
- Do not continue without explicit, user-scoped provider re-approval for the same task context.

## Verification and execution

- `unverified`: result received but not checked.
- `needs_more_context`: result requests an allowed bounded continuation.
- `verified`: Luna checked the relevant claim or artifact locally.
- `rejected`: result conflicts with local evidence or violates the packet.
- `blocked`: no safe route or required modality remains.

Never move to editing or external execution while a required result is `unverified`, `rejected`, or `blocked`.

Verification is normally a focused Luna check, not a second model pass: inspect the cited paths, symbols, facts, diff, and relevant test output; confirm the modality and scope; and check that the fallback evidence really proves the preceding route failed. Do not resend the full source or rerun the same reasoning just to change the model.

For high-risk work, add one verifier route only when a specific falsifiable claim remains unresolved after local checks. Give it the primary conclusion, the minimum supporting evidence, the current diff or test result, and one to three focused questions. Prefer a free Web-LLM verifier when external judgment is necessary; do not make V4 Pro a verifier by default. Skip the verifier when there is no unresolved claim. A verifier response is still evidence and never replaces Luna's local acceptance decision.

## Direct references

- Read [communication-contract.md](references/communication-contract.md) for packet, transport, receipt, and lifecycle fields.
- Read [routing-matrix.md](references/routing-matrix.md) for route selection, reasoning levels, and fallback rules.
