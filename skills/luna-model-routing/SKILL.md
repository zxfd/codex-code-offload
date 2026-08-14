---
name: luna-model-routing
description: Route substantive source, log, document, browser, and visual analysis away from the coordinating Codex task before it reads task evidence; coordinate explicit Medium Codex Threads, free-first Web-LLM Browser Adapter work, bounded receipts, parallel branches, and a one-attempt DeepSeek V4 Pro fallback. Use for model selection, cross-model communication, source-context offload, Web-LLM delegation, or serial and parallel fallback decisions.
---

# Model Routing

Treat the current model as the coordinating Agent. Choose the evidence owner before substantive task evidence enters the current task, send one self-contained packet, wait for a bounded receipt, and integrate only after focused verification.

This Skill is a routing layer. It does not replace repository, Skill-lifecycle, domain, privacy, identity, or approval rules.

## Keep responsibilities and approvals separate

- Let `luna-model-routing` own only classification, route selection, task packets, transport, fallback, receipts, and route verification state.
- Let `skill-creator` own Skill design, resource structure, official validation, and forward-testing policy.
- Let `repo-execution` own CodeGraph and repository navigation conventions, Git scope, commits, pushes, naming, and installed-Skill integrity checks.
- Let each domain Skill own its identities, data minimization rules, browser preconditions, approval gates, external actions, and live success evidence.
- Treat an outer rule naming a historical route or model as a trigger to consult this Skill, not as permission to bypass the current matrix.

This Skill does not grant, infer, duplicate, or relax approval. A route change never carries approval to publish, send, delete, pay, change accounts, transfer private data, or perform another representative action. Workers do not perform those actions and do not create more Workers.

## Route before reading task evidence

Classify every prospective read by what its output contains, not by the command or tool used.

### Reads allowed before routing

The coordinating Agent may read only:

- active `AGENTS.md` rules, every triggered `SKILL.md`, and the required references selected by those Skills;
- bounded operational metadata such as repository root, branch, status, upstream, file paths, file types, byte counts, hashes, manifest keys, installed-Skill location, and test identifiers;
- exact user-supplied replacement text when the file, location, and transformation are already explicit and require no contextual interpretation.

Skill-instruction reads are mandatory control context, not task-source analysis. Metadata checks must not emit source bodies, long logs, document prose, DOM, OCR, screenshots, or business records.

### Evidence that must be routed first

Create a separate analysis route before reading any task evidence needed to understand behavior, choose a change, or form a conclusion. This includes:

- source discovery, source triage, implementation tracing, symbol relationships, or cross-file impact;
- logs, documents, reports, transcripts, database rows, page text, DOM, OCR, screenshots, or visual evidence that require extraction, correlation, or summarization;
- an unknown implementation target, a broad search, or any code change whose correctness depends on surrounding business logic;
- architecture, difficult root cause, security-sensitive analysis, or input that exceeds a verified safe context budget.

Command form is not an exemption. Output from `rg`, `sed`, `cat`, a script, an editor preview, a database client, or a browser inspection is still a substantive read when it exposes task evidence.

Do not read substantive task evidence and then delegate the same analysis. Do not start a delegated route and continue the assigned analysis locally while it runs. If substantive evidence enters the coordinating task before routing, record the boundary failure; do not describe the later delegation as context offload.

When uncertain, classify the read as substantive and route it.

### Focused work allowed after a receipt

After the evidence owner returns, the coordinating Agent may:

- verify the receipt's real Thread or Provider identifiers, cited paths, symbols, fingerprints, and unresolved items;
- inspect only the exact cited hunk, symbol, short failure tail, diff, or test output declared in the acceptance criteria;
- perform a focused write from a verified `edit_spec`, then run deterministic formatting, tests, hashes, Git checks, and installed-state checks;
- ask the same route once for one concrete missing fact when focused verification fails.

Do not repeat the original source analysis. If implementation needs uncited context, stop the write and continue the original route once with the minimum missing question.

## Select one primary route

Read [routing-matrix.md](references/routing-matrix.md), then choose one route:

- `local_exec`: instruction reads, bounded metadata, deterministic commands, exact mechanical edits, and focused acceptance checks.
- `analysis_thread`: a separate text-only Codex Thread using `gpt-5.6-luna` with `thinking: medium`; it owns substantive source, log, or document reading and returns a bounded receipt plus an `edit_spec` when code changes are needed.
- `current_write`: the current model performs only the focused implementation or integration authorized by a verified analysis receipt. This route does not reopen discovery.
- `browser_adapter` or `web_llm_thread`: the free-first route for architecture, difficult root cause, security-sensitive work, large private-safe packets, or visual evidence.
- `v4_fallback_thread`: one text-only `deepseek-v4-pro-deepseek` attempt after every eligible Web-LLM Provider in that serial route or parallel branch has failed.

Use [communication-contract.md](references/communication-contract.md) for packet, transport, receipt, and continuation fields. Route once; do not call every model as a panel.

## Use the Medium analysis Thread

Use Codex App Thread tools rather than native subagents for `analysis_thread`:

1. Locate the matching project when repository context is required.
2. Create one Thread with `model: gpt-5.6-luna`, `thinking: medium`, a complete packet, and `owned_paths: read-only`.
3. Confirm a real `thread_id` and `host_id` plus readable turn state. A timeout, empty ID, or client-only ID is not a usable analysis Thread.
4. Wait with bounded progress snapshots and read the final receipt.
5. Ask once in the same Thread only when a declared acceptance check exposes one concrete missing fact.
6. Archive the Thread only after the receipt is accepted.

The coordinating Agent may packetize paths, user goals, rules, and metadata, but it must not inspect the substantive input assigned to this Thread. If the explicit Medium Thread is rejected or unavailable, use the fallback matrix; never silently take the source-analysis role back into the current task.

## Use Web-LLM free first

Use the existing `agentchat-code-offload` Browser Adapter. Resolve its one-shot entry from the plugin cache root:

```text
${HOME}/.codex/plugins/cache/openai-bundled/browser/<version>/scripts/browser-client.mjs
```

Verify that resolved file before use. For this repository, use `skill/scripts/browser-client-entry.mjs` and retain the resolved absolute path in the receipt.

- Pack only task-scoped literal files through `codex-agentchat-offload.mjs`.
- Keep raw packed context out of the coordinating task; accept only the bounded Provider conclusion and receipt.
- Use `runProviderFallback` and the configured sequential Provider chain. Do not inspect Provider DOM manually or invent selectors.
- Keep internal Codex models out of `providers.json`. A Web-LLM workflow Thread is only the communication shell; record `model_source=web_provider`.
- For parallel work, create one Web-LLM Thread per genuinely independent branch. Keep the Provider chain sequential inside each branch.
- Never claim a text-only model saw pixels. If every visual Provider fails, return `blocked` unless independent local visual proof exists.

For a serial text route, or independently for each parallel text branch, use:

```text
eligible Web-LLM Provider chain
  -> one V4 Pro Thread attempt only after the chain fully fails
  -> current-model takeover only for an exact mechanical remainder within a verified safe budget
  -> blocked when no safe route remains
```

Do not create V4 Pro preemptively, retry it twice, or re-enter Web-LLM after it fails.

### Mandatory URL ingestion gate for new Chrome tasks

For a fresh task based on one explicit user-approved `http` or `https` URL that requires a new Chrome tab:

1. Run the installed Skill's `scripts/health-check.mjs` health check against `/Users/gin/.agents/skills/luna-model-routing`. Treat failure as fail-closed: do not open Chrome or call a Provider.
2. Run `ingestSingleUrlWithLocalContext` from `skill/scripts/web-ingest.mjs` before every Provider call, using exactly:

```text
{
  allowText: true,
  allowVisual: true,
  allowExternalTransfer: false,
  maxImages: 4,
}
```

3. Expect `status: requires_user_approval`, return its bounded receipt, and request explicit user approval for the specific page-data transfer and one named provider.
4. After approval, run the same helper again with `allowExternalTransfer: true` and a wrapped `runProvider` that can call exactly that named provider once.

This is a two-step route. Reject URL lists, wildcard URLs, separators, or redirects that change origin. Use a new Chrome task tab for pre-ingest and continue only with the same `request_id`.

The ingestion helper owns capture, sanitization, temporary prompt and image artifacts, and cleanup. The coordinating Agent receives only bounded signals, modality, risk, Provider identity, attachment readiness, status, and error reason; it must not receive raw DOM, page body, OCR, screenshots, cookies, storage, query tokens, or reusable temporary paths.

If the named provider fails for the approved page data, stop and request a fresh named-provider approval. Do not continue to another Provider or the normal fallback chain under the previous approval.

## Verify and finish

Use these states:

- `unverified`: receipt received but not checked;
- `needs_more_context`: the original route may answer one bounded continuation;
- `verified`: focused local evidence supports the receipt;
- `rejected`: receipt conflicts with local evidence or scope;
- `blocked`: no safe route or required modality remains.

Do not edit or execute an external action from a required receipt that is `unverified`, `rejected`, or `blocked`. Treat every Worker and Web-LLM answer as evidence, never as authorization or completion.

Keep final verification narrow: receipt identifiers, cited paths or symbols, changed hunks, `git diff --check`, targeted tests, and the installed-state checks owned by the applicable Skills. Add a separate verifier only for a specific falsifiable risk that remains after those checks.
