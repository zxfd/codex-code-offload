# Luna Model Routing Communication Contract

Use one contract for internal Codex Threads and Web-LLM executed through the Browser Adapter. The transport differs; the coordination and verification semantics do not. A parallel Web-LLM branch uses a Codex App Thread as its communication/workflow shell, while the actual reasoning source remains the Browser Adapter Provider.

## Task packet

Every delegated request must be self-contained and contain:

```text
route_id: stable ID for the complete route attempt
execution_mode: serial | parallel
branch_id: unique branch ID when execution_mode is parallel
role: one clear responsibility
objective: one required outcome
scope: included files, symbols, evidence, or question
authoritative_reads: facts already checked locally
do_not_rescan: context that must not be reread without new evidence
owned_paths: isolated write scope, or read-only
context_policy: source_once | patch_only
one_required_output: exact result or artifact expected
acceptance_criteria: how Luna will verify the result
constraints: no child Workers, no external actions, preserve user changes
```

For Spark code work, add `context_policy: source_once | patch_only` to the packet and use `source_once`: Spark owns the source context, while Luna receives only the bounded receipt plus focused diff/test evidence. Do not paste the original source or packed prompt into Luna a second time.

For a verifier packet, add only:

```text
verification_scope: the exact claim or risk still unresolved
verification_evidence: minimum conclusion, paths, diff, and test result needed to challenge it
verification_questions: one to three falsifiable questions
```

Never repack the complete original input for verification unless Luna records why a specific missing fact requires it.

For Web-LLM, the local adapter remains responsible for literal path validation, secret scanning, extraction, packing, and image policy. Do not paste credentials, cookies, tokens, broad repository context, or unrelated private data.

## Transport mapping

| Transport | Recipient | Send mechanism | Continue mechanism | Result source |
|---|---|---|---|---|
| `local_exec` | current Luna task | local tool | current task | command/test/artifact |
| `codex_thread` | Spark / V4 Flash / V4 Pro | Codex App Thread | original Thread message | Thread result |
| `browser_adapter` | Web-LLM Provider | existing offload adapter | same `request_id`, bounded continuation | Provider answer |
| `web_llm_thread` | one Web-LLM branch | new Codex App Thread wrapping the Browser Adapter | original Thread message plus same `request_id` | Browser Adapter receipt returned by that Thread |

The transport value is part of the receipt and must never be inferred from the model name alone.

For `browser_adapter` and `web_llm_thread`, validate the Browser Adapter entry once from the plugin cache. Use the repository helper when working in this project:

```text
${HOME}/.codex/plugins/cache/openai-bundled/browser/<version>/scripts/browser-client.mjs
```

Do not build this path from `.../skills/control-in-app-browser/...`; only use it after the resolved file is verified to exist for the active plugin version.

## Receipt

Return or record at least:

```text
route_id
attempt
execution_mode
transport
model
thinking
role
input_size
modality
status: planned | running | needs_attention | completed | failed | accepted | blocked
fallback_reason
verification_state
thread_id / host_id      # codex_thread or web_llm_thread
request_id / provider    # browser_adapter or nested web_llm_thread
output_ref
verification
changed_files
diff_stat
tests_run / test_result
unresolved
```

Use `model_source=codex_internal` for internal Threads and `model_source=web_provider` for Web-LLM. Keep `thread_id` and `request_id` distinct.

## Lifecycle

1. Luna creates the `route_id` and chooses `execution_mode`.
2. For an internal route, use `codex_app__list_projects` when a workspace is needed, then `codex_app__create_thread` with the explicit model, thinking, packet, and project. For a parallel Web-LLM route, create one new Thread per branch and make the Browser Adapter the only reasoning source for that Thread.
3. Luna sends exactly one primary packet unless a declared independent parallel split exists; use `codex_app__send_message_to_thread` for every internal or Web-LLM branch Thread.
4. The transport returns a result and receipt; use `codex_app__read_thread` or `codex_app__wait_threads` for Thread status/results, and preserve the nested Web-LLM `request_id` and Provider attempts.
5. Luna performs focused local verification from the bounded receipt and changed hunks; it does not repeat the original source analysis.
6. Luna may ask the same internal Thread once only for a concrete failed check or unresolved falsifiable claim, sending the minimum failure tail and claim; never resend the complete packet by default.
7. Luna applies the route matrix fallback, preserving the same `route_id` and incrementing `attempt`.
8. Luna accepts or blocks the route, then edits/tests/ships from the current task. Archive an accepted internal or Web-LLM workflow Thread only after verification with `codex_app__set_thread_archived`.

Do not create a replacement merely because a progress snapshot is unchanged. Create one only after a real failure, a declared dependency change, or a documented verification conflict.
