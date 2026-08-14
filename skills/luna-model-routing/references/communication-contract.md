# Model Routing Communication Contract

Use one contract for internal Codex Threads and Web-LLM work. The coordinating Agent chooses transport before substantive task evidence is read, and every transport returns a bounded routing receipt.

## Packet

Build a delegated packet only from user instructions, active control rules, paths, bounded metadata, and acceptance criteria:

```text
route_id: stable ID for the complete route
attempt: monotonic attempt number
execution_mode: serial | parallel
branch_id: required for a parallel branch
transport: analysis_thread | browser_adapter | web_llm_thread | v4_fallback_thread
role: one clear responsibility
objective: one required outcome
scope_paths: literal task-scoped paths or URLs
allowed_instruction_reads: active rules and triggered Skill instructions
allowed_metadata: facts already checked without exposing task evidence
do_not_read_in_coordinator: source, logs, documents, DOM/OCR, images, or other assigned evidence
do_not_rescan: evidence already owned by another route
owned_paths: read-only unless an explicit isolated artifact is permitted
context_policy: source_once
one_required_output: exact receipt or artifact
acceptance_criteria: focused checks the coordinator may perform
constraints: no child Workers, external actions, commits, pushes, or approval changes
```

Do not put source excerpts, full logs, document bodies, DOM, OCR, screenshots, cookies, tokens, or unrelated private data into the packet merely to make it self-contained. Self-contained means operationally complete, not evidence-duplicating.

For a code-analysis route, require an `edit_spec`:

```text
path
symbol_or_anchor
anchor_fingerprint
required_transformation
cross_file_effects
targeted_tests
unresolved
```

The `edit_spec` must be specific enough for focused implementation without repeating discovery. If it is not, continue the same route once with one missing question.

For `analysis_thread`, require:

```text
model: gpt-5.6-luna
thinking: medium
model_source: codex_internal
owned_paths: read-only
context_policy: source_once
```

For a verifier, add only the exact unresolved claim, minimum evidence, current diff or test result, and one to three falsifiable questions. Never resend the complete original input by default.

## Transport mapping

| Transport | Evidence owner | Result source | Coordinator boundary |
|---|---|---|---|
| `local_exec` | coordinating Agent | command, test, hash, or metadata | no substantive task evidence before routing |
| `analysis_thread` | separate Medium Codex Thread | Thread receipt and optional `edit_spec` | packetize, wait, and verify only |
| `current_write` | coordinating Agent | focused diff and tests | use a verified receipt; do not reopen discovery |
| `browser_adapter` | Web-LLM Provider | Provider answer plus adapter receipt | raw packed context stays outside the coordinating task |
| `web_llm_thread` | Web-LLM Provider inside one Thread shell | Browser Adapter receipt returned by that Thread | host-model prose is not the Provider result |
| `v4_fallback_thread` | DeepSeek V4 Pro | Thread receipt | one text-only attempt after eligible Web-LLM exhaustion |
| `url_preingest` | `ingestSingleUrlWithLocalContext` | bounded local receipt | no Provider call before explicit named-provider approval |

The transport field is authoritative. Do not infer it from a model name.

For Browser Adapter work, resolve and verify:

```text
${HOME}/.codex/plugins/cache/openai-bundled/browser/<version>/scripts/browser-client.mjs
```

Do not construct the entry from a Browser Skill directory. In this repository, use `skill/scripts/browser-client-entry.mjs`.

## Receipt

Return or record:

```text
route_id
attempt
execution_mode
branch_id
transport
model
model_source
thinking
role
input_size
modality
status: planned | running | needs_attention | completed | failed | accepted | blocked
fallback_reason
verification_state
thread_id / host_id
request_id / provider
output_ref
edit_spec
evidence_checks
changed_files
diff_stat
tests_run / test_result
unresolved
summary
```

Keep `thread_id` and `request_id` distinct. A client-only ID is setup state, not a completed Thread receipt.

## Lifecycle

1. Classify prospective reads as instruction context, metadata, substantive task evidence, or focused acceptance evidence.
2. Create `route_id` and choose one primary route before substantive evidence enters the coordinating task.
3. For `analysis_thread`, locate the project, create a separate `gpt-5.6-luna` Thread with `thinking: medium`, confirm real identifiers, and send one packet.
4. For Web-LLM, send only literal task-scoped inputs through the Browser Adapter. For a parallel route, use one Thread shell per independent branch while keeping that branch's Provider chain sequential.
5. Wait for the bounded receipt. Do not run the delegated analysis locally while waiting.
6. Mark the receipt `unverified`, then perform only its declared focused acceptance checks.
7. If one concrete fact is missing, ask once in the original Thread or Provider context; do not create a replacement or resend the full input.
8. Apply the route matrix fallback with the same `route_id` and an incremented `attempt`.
9. After verification, perform any focused `current_write`, deterministic tests, repository checks, and installed-state checks.
10. Archive accepted workflow Threads only after integration evidence is recorded.

Do not create a replacement because a progress snapshot is unchanged. Create one only after a real failure, dependency change, or verification conflict.

## Approval boundary

Routing approval and action approval are different:

- Creating an analysis Thread does not approve external transfer.
- Approving one Provider does not approve another Provider or a retry.
- Approving analysis does not approve sending, publishing, deleting, paying, account changes, or production actions.
- A domain Skill's identity, privacy, and representative-action gates remain authoritative.

The routing receipt records approval state but never creates it.

## Fresh single-URL pre-ingest

Before opening a new Chrome task tab for one explicit `http` or `https` URL:

1. Run the installed routing Skill's health check. On failure, return `blocked`; do not open Chrome or call browser or Provider APIs.
2. Run `url_preingest` through `ingestSingleUrlWithLocalContext` with `allowExternalTransfer: false`.
3. Return its bounded receipt. If status is `requires_user_approval`, stop for explicit approval naming the page-data action and exactly one Provider.
4. After approval, invoke the helper again with `allowExternalTransfer: true` and a `runProvider` wrapper limited to that Provider once.

Reject multiple URLs, wildcard URLs, separator tricks, and cross-origin redirects. Keep raw page data and temporary artifacts inside the helper.

If the approved named Provider fails, do not continue to fallback providers. Stop and request a fresh named-provider approval for the same page data.
