---
name: repo-execution
description: Apply stable repository execution conventions for code navigation, scoped Git changes and commits, and human-versus-machine file naming. Use for repository implementation, refactoring, debugging, file organization, or rename tasks.
---

# Repository Execution

Apply these stable repository conventions. Let more specific project rules and platform requirements take precedence.

## CodeGraph

- Check whether the repository root contains `.codegraph/` before code-structure work.
- When it exists and the task requires understanding structure, locating symbols or implementations, analyzing calls, or tracing cross-file data flow or dependencies, prefer CodeGraph:
  - Use `codegraph_explore` when its MCP tool is available.
  - Otherwise run `codegraph explore "<symbol names or question>"`.
- Do not create an index when `.codegraph/` is absent.
- Supplement CodeGraph with `rg`, Git, focused file reads, tests, or other local tools when useful.
- Skip CodeGraph for a simple mechanical change whose exact file and location are already known.

## Git and commits

- Preserve unrelated user changes; do not overwrite, restore, delete, or stage them.
- Modify only files needed for the current task.
- Before a commit, inspect the task-relevant diff, run the smallest sufficient verification, stage only task files or hunks, and confirm that the commit is non-empty and free of unrelated changes.
- Make a separate commit only for a key, independently verifiable unit. Do not commit mechanically after minor edits or split solely to reach a commit count.
- Use Conventional Commit / Angular-style subjects by default: `type(scope): 中文概要`.
- Create local commits when appropriate. Do not push, force-push, publish a branch, or otherwise write remotely without explicit user authorization.

## File and directory names

- Use clear Chinese names by default for human-maintained documents, records, status files, phase directories, content-production materials, and other reader-facing artifacts.
- Keep machine interfaces in English: source/tooling directories, package and module names, API and database fields, configuration keys, commands, environment variables, stable IDs, and externally prescribed paths or identifiers.
- Separate a human-facing name from a stable machine ID when both are needed.
- Before renaming an existing path, check code and configuration references, imports, shell scripts, CI, documentation links, and build or deployment configuration. Update affected references and run appropriate verification after the rename.
- In version-controlled repositories, use a Git-recognized move when practical.
