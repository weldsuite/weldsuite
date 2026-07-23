# Autopilot runtime directory

Claude Code writes daily digest files here when running in autopilot mode or when the Cowork batch pre-work task is triggered manually (the scheduled auto-run is disabled, manual "Run now" only).

## What's in here

- `digest-YYYY-MM-DD.md`, one file per day. Each entry summarizes one batch-pre-worked task (with queued interview questions) or one autopilot-closed task.
- This README.

## How to review

Open the latest `digest-*.md`. Each entry links back to the WeldSuite task. Pre-worked tasks have a `## Pending interview` block in their description with queued questions, run `/enrich <task-id>` in Claude Code to answer them interactively. If a pre-work entry looks wrong:

1. Open the WeldSuite task
2. Everything above the `---` separator is the original description (always preserved)
3. Remove the `## Pending interview` or `## Enriched analysis` block to revert
4. Re-run `/enrich <task-id>` to redo the interview

## How to run the manual batch pre-work

The scheduled auto-run is disabled. To trigger a batch pre-work pass on demand, open Cowork → scheduled tasks → find `weldsuite-autoenrich-hourly` (legacy id) and click **Run now**. It processes up to 10 unenriched tasks, appending a `## Pending interview` block to each. Later, run `/enrich <task-id>` in Claude Code to turn each pre-worked task into a full enrichment via interactive interview.

The `/autopilot` command in Claude Code is independent, it always does interactive interviews, never silent pre-work.
