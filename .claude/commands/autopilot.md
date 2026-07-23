---
description: Drive the WeldSuite task backlog end-to-end. Picks the highest-priority unstarted task, enriches it, dispatches, triages, implements, and stops only at the four hard gates. You only answer questions, no commands to type.
argument-hint: [--max N]
---

Run the autopilot loop. You (the user) only interact via AskUserQuestion prompts at the four hard stops. No typing commands between iterations.

Interpret `$ARGUMENTS`:
- `--max N` → cap at N iterations (default: 5). Prevents runaway sessions.
- Anything else → pass-through to downstream agents.

## The loop

Repeat up to `--max` iterations OR until no eligible tasks remain OR the user cancels:

### 1. Pick next task

Call `mcp__weldsuite__search_tasks` to list open tasks. Rank by:
1. Priority: `critical` > `high` > `medium` > `low` > `none`
2. Type: `bug` before `feature`/`story`/`task` at same priority
3. Due date: earliest first at same priority + type
4. Created date: oldest first at same everything

Filter out:
- Tasks with status `done`, `cancelled`, `in_review`, `testing`
- Tasks with an assignee that is NOT the current user (respect others' work)
- Tasks tagged `needs-info` or `blocked`
- Tasks that failed autopilot in this session (avoid infinite loops)

If the queue is empty, print "Autopilot: no eligible tasks. Stopping." and exit.

Announce the pick:
```
━━━━━━━━━━ Autopilot iteration <n>/<max> ━━━━━━━━━━
Picked: <task-id>, <title>  [priority: <p>, type: <t>, due: <d>]
```

### 2. Claim it

Call `update_task` to set `status: in_progress` and assign to the current user if unassigned. Short comment: "Autopilot: claiming for work".

### 3. Enrich (interactive interview, if not already enriched)

If the task description does NOT contain `## Enriched analysis`, invoke the `task-enricher` agent in interactive mode (no `--auto`). The enricher will:
- Do a first-pass codebase exploration (~10 reads)
- **Interview the user** with a dynamic question set in rounds of 1–4 questions via `AskUserQuestion`, no hard cap, with an "I've said enough" escape from round 2 onward
- If the description has a `## Pending interview` block (left by a manual batch pre-work run), use those queued questions as round 1
- Draft the "Enriched analysis" block with a decisions-locked-in table
- Show the draft for approval, user picks `yes` / `edit` / `cancel`
- On `yes`, append via `update_task`; on `cancel`, abort the whole autopilot iteration for this task

**HARD STOP A:** the entire interview IS a series of hard stops, every round pauses until the user answers. This is the single largest pause in the autopilot loop, which is by design: the interview captures the decisions that shape everything downstream. If you're short on time, pass `--skip-enrich` to autopilot (coming in a future update) or use `/fix-bug` with `--skip-enrich` on a single task.

### 4. Dispatch

Invoke `weldsuite-dispatcher`. Use the enricher's suggested specialist chain as the starting point; the dispatcher may refine it but should not contradict it without reason.

### 5. Triage (or design sketch)

- If task type is `bug` → invoke `bug-triage`. It reproduces, roots, writes a fix plan.
- Otherwise → invoke `bug-triage` in design-sketch mode (per `/feature`).

**HARD STOP B:** if triage reports "cannot reproduce" on a bug, call `update_task` to tag the task `needs-info` with a comment listing exactly what info is needed (video, workspace id, exact repro steps), then continue the loop with the NEXT task. Do not proceed to implementation for an unreproducible bug.

### 6. Implement

Invoke the specialist(s) named by the dispatcher, in dependency order (database → backend → frontend → mobile). Each specialist reads the enrichment + triage plan + prior specialists' diffs.

**HARD STOP C:** if any specialist determines a database migration file must be generated, STOP the loop and ask via `AskUserQuestion`:
- "Proceed and generate the migration?" / "Skip the migration, take column changes only?" / "Abort this task"
Wait for the answer. Per CLAUDE.md, migrations are never auto-generated.

### 7. DoD checks

Run the full Definition of Done in bash:
```bash
cd /sessions/focused-inspiring-franklin/mnt/weldsuite
pnpm --filter '<touched-workspaces>' lint
pnpm --filter '<touched-apps>' build
git status --porcelain
```

If any check fails, STOP the loop and report the failure. Do NOT auto-retry, do NOT auto-revert.

Confirm (automatically, no user prompt):
- Every Drizzle query touched has `workspaceId` scoping
- Every new/changed route has a `weld*` permission check
- Any new user-visible string has `en` AND `nl` translations
- No new `console.log`, `any`, `@ts-ignore`

### 8. Review gate

**HARD STOP D:** before opening a PR or pushing anything, show the diff in chat:

```
━━━━━━ DIFF for <task-id> ━━━━━━
<git diff output, truncated to 200 lines with a "... (N more lines)" marker>
━━━━━━ END DIFF ━━━━━━
```

Ask via `AskUserQuestion`:
- "Open PR and close task" / "Hold, I'll review the diff in my editor" / "Revert this change"

Do NOT call `gh pr create` or push without an explicit "open PR" answer.

### 9. Close

On "open PR and close task":
1. Commit with message `fix(<module>): <task title> (<task-id>)` or `feat(<module>): ...` for features.
2. Push the branch.
3. Open the PR via `gh pr create` with body linking to the WeldSuite task.
4. Call `update_task` to flip status to `in_review`, add a comment with the PR URL.
5. Append a closing entry to the daily digest:
   ```
   ✅ <task-id>, <title>, PR <url>
   ```

### 10. Loop or stop

Decrement the iteration counter. If > 0, go to step 1. Otherwise, print:
```
━━━━━━ Autopilot complete ━━━━━━
Iterations: <done>
Closed: <n tasks> (<list of ids>)
Paused on hard stop: <n> (<list of ids + reason>)
Digest: .claude/autopilot/digest-<YYYY-MM-DD>.md
```

## Cancellation

The user can stop autopilot at any hard-stop AskUserQuestion by selecting "Cancel autopilot" (always offer this as one of the options on review-gate questions). On cancel:
- Do NOT revert in-flight work
- Do NOT close or modify the current task's status
- Print a one-line summary of where we stopped

Outside of hard stops, the user interrupts with Ctrl-C like any other long-running command, the partial work will be left where it is.

## Hard stop summary (what will pause the loop)

1. **Enricher ambiguity**, AskUserQuestion from the enricher; can't be auto-resolved.
2. **Unreproducible bug**, triage bails, task marked `needs-info`, loop moves to NEXT task (not a full stop, a skip).
3. **Migration required**, AskUserQuestion; user approves or aborts the task.
4. **Review gate before PR**, AskUserQuestion with the diff shown.

## What autopilot will NOT do

- Will not modify tasks you don't own
- Will not delete files, directories, or databases
- Will not run `pnpm build` or `pnpm lint` with `--force` / `--no-verify`
- Will not push to `main` directly, always a PR
- Will not bypass the review gate because a task looks "trivial"
- Will not silently auto-enrich, every task goes through an interactive interview (the manual batch pre-work run is separate, triggered via Cowork "Run now")
- Will not re-enter a task it closed earlier in the same session
- Will not work on more than one task at a time, strictly sequential

## Recovery

If a run ends unexpectedly (process killed, network error), the in-flight task is left in `in_progress` with its branch intact. Re-running `/autopilot` will pick it up again (the enrichment is idempotent; the specialist will see the uncommitted diff and resume).
