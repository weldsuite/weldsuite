---
name: enrich-task
description: Interview the user to fully specify a WeldFlow task, then append an Enriched analysis block via WeldSuite MCP. Use for /enrich-task before implementing under-specified bugs or features.
disable-model-invocation: true
---

# Enrich WeldFlow task

Enrich task `$ARGUMENTS` before implementation.

## Steps

1. `get_task` and read the full description + comments.
2. If `## Enriched analysis` already exists, report that and stop (do not overwrite).
3. Explore the current workspace just enough to ask informed questions (likely files, existing patterns).
4. Interview the user in short rounds (1–4 questions each) until scope, UX, and acceptance criteria are clear. Offer an “I’ve said enough” escape after round 1.
5. Draft an `## Enriched analysis` block including:
   - Problem summary
   - Decisions locked in (table)
   - Acceptance criteria
   - Out of scope
   - Existing patterns to mirror (paths in this repo)
6. Show the draft for approval. On yes, `update_task` to **append** the block below a `---` separator — never replace the original description.
7. Suggest `/fix-task <id>` next.
