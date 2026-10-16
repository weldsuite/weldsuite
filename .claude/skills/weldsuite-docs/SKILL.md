---
name: weldsuite-docs
description: "Read and update WeldSuite's design documentation: design docs and Architecture Decision Records (ADRs) in the separate weldsuite/weldsuite-documentation repo. Use before designing or changing how a platform area or weld* module works, when asked why something is built the way it is, when asked to check, write, update or supersede an ADR or design doc, and when a change makes, reverses or confirms an architectural decision."
---

# WeldSuite design docs and ADRs

How WeldSuite is built, and why, lives in the private repo
[`weldsuite/weldsuite-documentation`](https://github.com/weldsuite/weldsuite-documentation),
not in this one:

- `design/platform/*.md`: cross-cutting areas (API, data, identity, events, AI, billing, CI/CD, …)
- `design/modules/*.md`: one document per `weld*` module
- `adr/<PREFIX>-<NNN>-<slug>.md`: decision records, numbered per area (`API-003`, `DATA-004`, …)
- `open-questions.md`, `glossary.md`, `templates/`, and `CONTRIBUTING.md` (the rules for writing)

It is cloned **next to** the main checkout (`../weldsuite-documentation`), not as
a submodule. `docs/plans/` and `docs/decisions/` in this repo stay where they
are; the docs repo summarises and links to them.

## 1. Find the clone

Works from the main checkout and from any worktree under `.claude/worktrees/`:

```bash
DOCS="${WELDSUITE_DOCS_DIR:-$(dirname "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")/weldsuite-documentation}"
[ -d "$DOCS/.git" ] || gh repo clone weldsuite/weldsuite-documentation "$DOCS"
# Refresh only when the shared clone is on a clean main; never disturb other work in it.
if [ "$(git -C "$DOCS" branch --show-current)" = main ] && [ -z "$(git -C "$DOCS" status --porcelain)" ]; then
  git -C "$DOCS" pull --ff-only --quiet
fi
echo "$DOCS"
```

Shell state doesn't persist between commands, so use the printed absolute path
with Read / Grep / Edit afterwards. If the clone fails (no access to the private
repo), tell the user and carry on without the docs.

## 2. Read before changing an area

1. Find the area in `design/README.md` (design docs) and `adr/README.md` (ADRs
   grouped by prefix), or grep: `grep -ril "<term>" "$DOCS/design" "$DOCS/adr"`.
2. Read the area's design doc, then the ADRs it links to.
3. An **Accepted** ADR is a rule the code follows. If the task would break one,
   say so before coding and name the ADR: it needs either a different approach
   or a new ADR that supersedes it. Don't work around it quietly.
4. Most ADRs were recorded retroactively on 2026-10-16. Rationale marked
   *Inferred* is a reconstruction, not a confirmed reason; weigh it that way.
   `open-questions.md` lists what is still unconfirmed.
5. The docs can lag the code. When they disagree, `develop` is what runs; fix
   or flag the docs (section 3).

Cite ADRs by ID when explaining a design (`API-003`, `SEC-001`).

## 3. Update when something changes

Read `CONTRIBUTING.md` first; it is short and it is the authority.

| Situation | What to write |
|---|---|
| A change makes a decision that is expensive to reverse, constrains future work, or had a real alternative | New ADR, status **Proposed** |
| A change reverses or replaces an Accepted ADR | New ADR that supersedes it; on the old one edit **only** the status line, to `Superseded by [<ID>](<file>)` |
| A change alters how an area works | Edit its design doc in place |
| The user confirms or corrects *Inferred* rationale | Replace the inferred text, drop the *Inferred* marker, remove the entry from `open-questions.md` |
| You notice docs and code disagree | Fix the design doc, or add an entry to `open-questions.md` when you can't tell which is right |

No ADR for what a linter or a code review settles.

Mechanics:

- Next number for a prefix: `ls "$DOCS/adr" | grep "^<PREFIX>-" | sort | tail -1`, plus one. Numbers are never reused. A new prefix needs a row in the table in `CONTRIBUTING.md`.
- Start from `templates/adr.md` or `templates/design-doc.md`.
- In the same change, update the design doc that links the ADR, the area's table in `adr/README.md` (and the decision count in its first line), and `design/README.md` when a design doc is added.
- Style per `CONTRIBUTING.md`: code paths relative to this repo's root in backticks; links into this repo as full GitHub URLs on `develop`; name secrets and bindings, never their values; no credentials or customer data.

## 4. Branch, commit, PR

The docs repo has its own history: never put docs changes in a commit of this
repo. The clone is shared by every session and worktree on the machine, so keep
it on a clean `main` and write in a worktree of the docs repo:

```bash
grep -qx '.worktrees/' "$DOCS/.git/info/exclude" || echo '.worktrees/' >> "$DOCS/.git/info/exclude"
git -C "$DOCS" fetch --quiet origin
git -C "$DOCS" worktree add "$DOCS/.worktrees/<slug>" -b docs/<slug> origin/main
```

Edit under `$DOCS/.worktrees/<slug>/`, then:

```bash
W="$DOCS/.worktrees/<slug>"
git -C "$W" add -A
git -C "$W" commit -m "docs(adr): <PREFIX>-<NNN> <decision>"   # or docs(<area>): <summary>
git -C "$W" push -u origin docs/<slug>
gh pr create -R weldsuite/weldsuite-documentation --base main --head docs/<slug> --title "..." --body "..."
```

- Commit, push and open the PR under the same rules as code in this session: when the user asks, or as part of a flow that is already opening the code PR (`/weldtask`, `/fix-issue`).
- Link both ways: the docs PR body links the code PR, and the code PR body gets a `Docs: <docs PR URL>` line.
- An ADR goes in as **Proposed** and flips to **Accepted** when the code lands (a follow-up commit on the docs PR, or a small PR after the merge).
- After the docs PR merges: `git -C "$DOCS" worktree remove "$DOCS/.worktrees/<slug>"`.

## Setup on a new machine

1. Clone next to the main checkout (section 1 does this on first use), or set
   `WELDSUITE_DOCS_DIR` to wherever the clone lives.
2. Add the clone's absolute path to `permissions.additionalDirectories` in the
   user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`)
   of every Claude profile in use, so reading and editing it doesn't prompt.
   It belongs in user settings because the path differs per machine.
