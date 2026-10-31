# Agent fleet: Claude Code agents that work the WeldSuite backlog until it is empty

Status (2026-10-31): plan, not built. The owner answered the design questions
(see "Owner answers"). Phase 0 checks the assumptions marked *(verify)* before
any runner code is written. The build tasks are mirrored in the WeldSuite
project "Agent fleet".

A runner on the owner's PC (later a Linux server) takes open WeldSuite tasks one
by one, hands each to a headless Claude Code session under one of several Claude
Team seats, and keeps going until no open task is left. Each task ends as a
merged PR into `develop`, a question to the owner, or a task handed back to a
person. When an agent needs context it asks in WeldSuite, on the task itself;
the owner answers there, and the agent picks up where it stopped.

## Owner answers (2026-10-31)

| Question | Answer |
|---|---|
| Where do the agents run? | On this PC first, with a runner built to move to a Linux server later |
| Which accounts? | Claude Team seats, one Claude Code profile per seat |
| What happens to a green PR? | Auto-merge into `develop` once the required checks and WeldSuite Review pass. The release PR to `main` stays the owner's |
| Where does the owner give context? | Task comments and tags now (phase 1); a dedicated Agent inbox next (phase 2) |
| Which tasks? | Every open task (todo and backlog) in every project, by priority, except tasks assigned to someone else or tagged `no-agent`. Non-code tasks are recognised in triage and handed back |
| Database migrations? | Agents generate them without asking, one at a time across the fleet |
| Where does the plan live? | This file, plus the WeldSuite project "Agent fleet" |

## Where we are today

- **`/weldtask` runs one task end to end, but interactively.** Every question
  goes through `AskUserQuestion` in a live session, and its hard stops
  (migrations, new tables, scope creep) wait for a person. Nothing in the repo
  can run a task unattended. The specialist agents in `.claude/agents/` and the
  Definition of Done in `CLAUDE.md` are reusable as they are.
- **The May workflow is strictly serial on purpose**
  (`.claude/workflows/bug-fix-and-feature-workflow.md`): parallel branches kept
  conflicting on the Drizzle migration folder, route mounts in
  `apps/workers/app-api/src/index.ts`, the locale files, the entity-event
  catalog and the provider chain in `__root.tsx`. A fleet has to handle those
  hotspots, not ignore them (section 6).
- **The backlog** on 2026-10-31: 158 tasks in todo, 88 in backlog, and 252 in
  review (fixed, waiting for the owner to verify).
- **`develop`'s ruleset** ("develop: PRs and CI") requires `Lint`, `Build`,
  `Type Check · app-api`, `Type Check · platform`, `Unit · app-api`,
  `Unit · platform` and `Rust`. Another ruleset requires `WeldSuite Review`
  (the AI reviewer in `weldsuite/pr-reviewer`) on `develop` and `main`. The
  checks are not strict (a PR need not be up to date with `develop`), and the
  repository allows auto-merge.
- **WeldSuite's public API** has what a runner needs for phase 1:
  `/v1/tasks` (list filtered by status, project, assignee, priority and type;
  no tag filter and no "updated since"), `/v1/task-comments` (list by task;
  `authorId` defaults to the API key's user; a `metadata` field) and
  `/v1/webhooks`. The entity-event catalog has `project_task.*` and
  `task_comment.*`.
- **The machine:** 32 threads, 64 GB RAM. About six heavy agents at once is the
  practical limit (a Flow conformance run peaks near 4 GB). E: is tight on disk;
  Rust builds go to `D:\ws-rust-targets\<name>`. Postgres for Rust tests runs in
  the `ws-rust-pg` container.
- **Subscription logins and the Agent SDK.** The Agent SDK's docs say Anthropic
  does not allow claude.ai login or subscription rate limits for products built
  on the SDK, unless previously approved. The runner therefore drives the
  regular Claude Code CLI in headless mode (`claude -p`), the documented way to
  script Claude Code, under each seat's own login.

## Design

```
 WeldSuite (tasks, comments, tags)            GitHub (PRs, checks, auto-merge)
        ▲   │ poll every 60 s                         ▲
        │   ▼                                         │ push branch, open PR
 ┌──────────────────────────────────────────────┐     │
 │ agent-fleet runner (apps/tools/agent-fleet)  │─────┘
 │ queue · seats · slots · locks · state (SQLite)│
 └──────┬──────────────┬──────────────┬──────────┘
        │ slot 1       │ slot 2       │ slot N        one git worktree per slot
        ▼              ▼              ▼
   claude -p       claude -p      claude -p           CLAUDE_CONFIG_DIR = a seat's profile
   /fleet-task     /fleet-task    /fleet-task         + the fleet MCP tools (ask, report, lock)
```

### 1. The runner

`apps/tools/agent-fleet`: a Node 22 + TypeScript process, started with
`pnpm --filter agent-fleet start`. Every 60 seconds it:

1. refreshes the queue from WeldSuite;
2. looks for answers on tasks waiting for the owner;
3. checks the fleet's open PRs (CI result, conflicts, merged);
4. checks `develop`'s CI after each merge;
5. starts a run in every free slot that has a seat with capacity.

State (runs, sessions, locks, seat cooldowns) lives in a small SQLite file
(`node:sqlite`) under `D:\fleet\state`, so a restart continues where it left
off. A status page on `http://localhost:4317` shows the seats, the slots, what
each run is doing, what waits for the owner and what merged today.
`fleet pause` stops new runs (running ones finish); the runner also pauses
itself while `develop` is red.

### 2. Seats

- One Claude Code profile per Team seat: `CLAUDE_CONFIG_DIR=D:\fleet\profiles\<seat>`,
  signed in once with `claude /login` by the person the seat belongs to.
- The config gives each seat a concurrency (start with 1, try 2) and a model.
- **Usage limits.** When a run ends on a usage limit *(verify the message and
  how it reports the reset time)*, the seat cools down until that time. The
  run's work is committed and pushed as WIP, the task gets a short handoff note,
  and it goes back to the queue. If the run was resumable, the next run resumes
  it on the same seat after the reset, or on another seat if moving a session
  between profiles works *(verify)*; otherwise a fresh run continues from the
  branch and the handoff note.
- **Terms.** Team seats are per person. Driving several seats from one runner
  is fine where each seat belongs to someone who uses it this way. Pooling seats
  only to raise the limits of one unattended runner may not fit the Team terms:
  confirm with Anthropic before adding seats. The runner also accepts an API key
  per profile (`ANTHROPIC_API_KEY`), which is the route Anthropic documents for
  unattended automation, so switching costs only configuration.

### 3. Picking work

- **Eligible:** status `todo` or `backlog`; type not `epic` (its subtasks are
  picked instead); no `no-agent`, `agent:human` or `agent:needs-input` tag;
  unassigned, or assigned to the owner or the fleet user; every `dependsOn`
  task done.
- **Order:** priority (urgent, high, medium, low), then bugs before features,
  then oldest first. The tag `agent:run` puts a task at the front, even one
  assigned to the owner.
- **Claim:** status `in_progress`, assignee the fleet user, tag `agent:running`,
  and a comment "Picked up by the agent fleet" with the seat and slot. With one
  runner there is no race. Two runners (PC and server) need a claim endpoint or a
  single coordinator; that is decided in phase 3.
- **Not for an agent:** triage classifies paperwork, go/no-go decisions,
  purchases, `tofu apply`, production secrets and similar as human work. The
  task is tagged `agent:human`, assigned back to the owner, and gets a comment
  saying why. A task too big for one PR (for example "Port Books") becomes a
  question: "Split it into these subtasks?", with the proposed list.

### 4. One run

- **Slots.** A fixed number of git worktrees on D: (`D:\fleet\slots\slot-<n>`)
  with warm `node_modules` and the pnpm store on the same drive. For each task:
  `git fetch origin develop`,
  `git switch -C fleet/task-<n>-<slug> origin/develop`,
  `pnpm install --frozen-lockfile` (seconds when warm), copy the platform `.env`,
  revert postinstall artifacts. The disk use stays the same however many
  tasks run.
- **Launch:**
  `claude -p "/fleet-task TASK-<n>" --output-format stream-json --verbose
  --settings fleet-settings.json --mcp-config fleet-mcp.json --model <seat's model>`
  with the seat's `CLAUDE_CONFIG_DIR` and a scrubbed environment (section 8).
  Permission mode: `auto` if it behaves headless, otherwise `bypassPermissions`
  behind the guard hook *(verify)*. The prompt carries a snapshot of the task:
  description, comments, the owner's earlier answers and any handoff note.
- **The skill `.claude/skills/fleet-task`:** `/weldtask` for unattended runs.
  Same steps (classify, `bug-triage`, specialists, Definition of Done, PR), with
  three changes:
  - questions go through the fleet tool `ask_owner`, never `AskUserQuestion`;
  - hard stops are fewer: generating a migration is allowed (after taking the
    `migration` lock); a new table, package, app or worker, a module route in
    `app-api`, or work outside the task's scope still ask;
  - it ends with `report_result`.
- **The fleet MCP server** (stdio, in the runner package) gives the agent four
  tools and keeps every credential on the runner's side:
  - `ask_owner(questions[])`: each question with options, a recommended option
    and why it matters;
  - `report_result(status, summary, prUrl?, followUps[])`, where status is
    `pr_opened`, `no_change_needed`, `human_only`, `duplicate` or `failed`;
  - `acquire_lock(name)` / `release_lock(name)` for the hotspots in section 6;
  - `create_follow_up(title, description)` for adjacent bugs found on the way
    (the runner creates the task; the agent never fixes them silently).
- **Sessions.** The runner keeps the session id from the stream's `init`
  message. Answers and CI failures resume that session
  (`claude -p --resume <id> "<answers>"`), so the agent keeps its context.
- **Limits per run:** a wall-clock cap (3 hours), and a stall check (no output
  for 20 minutes: stop, commit WIP, hand off). After three failed runs the task
  gets `agent:failed` and a comment with what was tried.

### 5. Asking for context

**Phase 1: comments and tags (works with today's WeldSuite).**

- `ask_owner` makes the runner post a comment on the task as the fleet user:
  numbered questions, the options with the recommended one first, and how to
  answer. The comment mentions the owner, and its `metadata` holds the questions
  and the session id. The task gets `agent:needs-input` and is assigned to the
  owner. The run commits its WIP, ends, and frees the slot.
- The owner answers in a comment. On every pass the runner reads the comments of
  `agent:needs-input` tasks; a comment from a person after the question is the
  answer. Short forms work: `1A 2B`, or plain text. Commands:
  - `/agent go`: take the recommended options;
  - `/agent human`: hand the task back to a person;
  - `/agent retry`: start over from `develop`;
  - `/agent cancel`: stop and cancel the task;
  - `/agent context <text>`: on any task, extra context for its next run.
- The answer resumes the session within a minute, on the same branch.
- The mention should notify the owner in the app and on mobile *(verify)*.

**Phase 2: the Agent inbox.**

- A platform page (WeldFlow → Agents) listing every open question across
  projects, with the options as buttons and a text field. An answer posts the
  same comment as phase 1 (with `metadata.answers`) and removes the tag. The
  page also shows what the fleet is doing: running, waiting, merged today,
  handed back.
- On the task panel: a "Run agent" button (adds `agent:run`) and "Add context".
- Instant resume: a WeldSuite outgoing webhook on `task_comment.created`
  reaches the runner through a Cloudflare Tunnel, so an answer resumes the run
  in seconds instead of within a minute.
- Built on tags and comment metadata, the inbox needs no new tables. If it needs
  a "tasks by tag" route in flow-api, that route lands in TypeScript and Rust
  together (WeldFlow is ported).

### 6. Parallel work without conflicts

- **Locks in the runner**, taken through `acquire_lock` and held until the PR
  merges or closes:
  - `migration`: one migration in flight across the fleet, from
    `db:generate` until merged. A second agent that needs one finishes
    everything else, then waits (the run ends with "waiting for lock" and
    resumes when it frees). No number collisions, no renumbering.
  - `entity-events`, `api-modules`, `rust-catalogs`: the typed catalogs and
    their Rust export (`pnpm rust:catalogs`).
  - One running task per module (crm, desk, flow, mail, …) by default, from the
    module triage names. Configurable.
  - Locale files and route mounts get no lock: their conflicts are additive and
    the rebase step resolves them.
- **Bundles.** When triage finds that two open tasks share a root cause, the
  runner claims both and one PR closes both, as the May workflow's bundles did.
- **Keeping PRs green.** The runner watches each fleet PR. A failed check or a
  merge conflict resumes the session with the failing job's log or "rebase on
  `develop`". After three attempts the task asks the owner.
- **`develop` health.** The rulesets don't require PRs to be up to date, so two
  green PRs can still break `develop` together. After every merge the runner
  watches `develop`'s CI. If it goes red: pause auto-merge, open a fix run on
  the most likely PR, and if that doesn't land within an hour, revert that PR
  and reopen its task. A GitHub merge queue on `develop` would prevent this
  outright; worth enabling once the fleet merges more than a few PRs an hour.
- **Rust parity.** A task that touches a ported module changes its Rust twin
  too; the `Rust` check enforces it. Triage gives each run a resource class
  (`light`, `ts-heavy`, `rust-heavy`); at most two `rust-heavy` runs at once on
  this PC.

### 7. Merging

- **The PR:** base `develop`, title `TASK-<n>: <title>`, the template's
  sections filled in (what and why, type, checklist, schema changes), a line on
  how to verify, and `Refs TASK-<n>`. Label `agent-fleet`. A migration, a new
  route or a permission change is called out at the top.
- **Gates:** the required checks and WeldSuite Review. The runner enables
  auto-merge with a merge commit (`gh pr merge --auto --merge`), matching how
  `develop` is merged today. The agent itself never merges.
- **Never auto-merged** (label `needs-owner`, the owner merges): changes to
  `.github/workflows`, `rust/deploy/**`, any `wrangler.toml` `[env.production]`
  section, `scripts/secrets/**`, billing and payment code, and anything the
  review flags as risky.
- **After the merge** the task moves to `review` (the board's "In review": fixed
  and waiting for the owner to check) with the PR link and how to verify. The
  owner marks it done, or reopens it with a comment, which starts a new run.
- `develop` deploys to test. The release PR from `develop` to `main` stays the
  owner's, so nothing an agent does reaches production without the owner.

### 8. Safety on this PC

The agents run code on the owner's machine, so they can reach whatever their
Windows user can reach.

- **A separate Windows user, `weldfleet`,** runs the runner and every agent. It
  has no wrangler or Doppler login, no Neon URLs beyond the dev `.env`, and no
  browser sessions. This is the main line of defence and costs nothing.
- **A scrubbed environment** per run: `PATH`, the profile dirs,
  `CLAUDE_CONFIG_DIR`, and `GH_TOKEN` for a fleet GitHub identity (a
  fine-grained token: contents and pull requests on `weldsuite/weldsuite` only;
  no admin and no workflow scope). No `CLOUDFLARE_*`, `DOPPLER_*`, `NEON_*` or
  cloud keys. Git commits as "WeldSuite Agent".
- **A guard hook** (`PreToolUse` on Bash and PowerShell, plus a path check on
  Edit and Write) and deny rules in `fleet-settings.json` refuse:
  - `wrangler deploy | secret | delete`, `doppler`, `tofu apply | destroy`;
  - `gh pr merge`, and `gh api` calls that change repository settings;
  - `git push` to `develop` or `main`, `--force` to any branch but the run's
    own, and bare `git stash` (the stash is shared between worktrees);
  - deletes and writes outside the slot and the scratch dir;
  - Postgres or HTTP calls to production hosts.
- **Prompt injection.** Task text is written by workspace members and can quote
  customer messages. The skill treats task text as data, not
  instructions; the guard hook and the missing credentials are the backstop.
- **The server phase** runs each slot in a container with no credentials at all,
  where the Claude Code sandbox is available.

### 9. Visibility

- On every task: comments for picked up, questions, PR opened, merged, handed
  back. Tags show the state at a glance (`agent:running`, `agent:needs-input`,
  `agent:human`, `agent:failed`).
- A daily digest in a WeldChat channel `#agent-fleet`: merged, waiting for the
  owner, handed back, failed, and seat usage.
- The status page on the PC, and per run: duration, turns, tokens, the seat, and
  every limit hit.

## Delivery

### Phase 0: check the assumptions (1–2 days)

- `claude -p` with `--output-format stream-json`: the session id, `--resume`,
  and what a usage-limit stop looks like on a Team seat (message, reset time).
- Whether a session can move to another seat's profile (copy its transcript).
- Headless permission behaviour: `auto` mode versus `bypassPermissions` behind
  the guard hook, on Windows.
- WeldSuite: tags in `/v1/tasks` responses, comment `metadata` round trip, how
  an API-key comment shows its author, and whether a mention notifies.
- Slots on D: with the pnpm store on D:, and the warm install time.
- The fleet GitHub identity: can its PRs auto-merge with WeldSuite Review as the
  only review?

Each answer goes into "As built" below; a "no" changes the design before code.

### Phase 1: the runner on this PC

- `apps/tools/agent-fleet`: queue, claim, slots, seats and cooldowns, SQLite
  state, the fleet MCP server, the guard hook and settings, PR watch and
  auto-merge, `develop` health watch, the status page.
- `.claude/skills/fleet-task`, and a fleet section in `CLAUDE.md`: what changes
  in an unattended run (migrations allowed one at a time, never merge, ask
  through the fleet tools).
- WeldSuite: a fleet member user with an API key (tasks and task comments read
  and write), the tags, and the `#agent-fleet` channel.
- GitHub: the fleet identity, its token, and the labels `agent-fleet` and
  `needs-owner`.
- The `weldfleet` Windows user and the seat profiles.
- **Trial:** two seats, two slots, ten low-risk bugs, with the owner watching.
  Exit: ten tasks merged without the owner touching code, no guard escapes,
  `develop` stayed green.

### Phase 2: scale and the Agent inbox

- More seats and slots (up to about six on this PC).
- The Agent inbox page, "Run agent" and "Add context" on the task panel.
- Webhook resume through a Cloudflare Tunnel.
- The daily digest; the automatic revert when `develop` stays red.
- Tune the module locks from what phase 1 shows.

### Phase 3: a Linux server

- A Hetzner dedicated server with one container per slot (Node 22, pnpm, the
  Rust toolchain, Playwright's Chromium, a Postgres sidecar), the seat profiles
  mounted per container, no production credentials on the box.
- If the PC keeps running too: a claim endpoint in WeldSuite (a lease with
  compare-and-set on the task, in TypeScript and Rust) or one coordinator that
  hands work to both machines.

### Phase 4 (optional): a QA fleet for "review"

The 252 tasks in review wait for the owner to check them. A QA run opens the
test app in a browser (Playwright, the QA workspace and test account), follows
the task's "how to verify", and marks the task done with evidence, or reopens it
with what it saw.

## Risks

- **Semantic conflicts break `develop`.** Covered by the health watch and the
  automatic revert; a merge queue removes it.
- **Quality drift**, for example a "fix" that deletes or skips a test. WeldSuite
  Review gates every PR, and the runner refuses to enable auto-merge on a diff
  that adds `.skip` or removes tests without a question about it.
- **Migrations without the owner's approval.** They reach the test databases
  when `develop` deploys. One at a time, called out at the top of the PR, and
  production still waits for the owner's release PR.
- **Load on this PC.** Rust conformance and the platform type-check are heavy;
  resource classes cap them.
- **Seat terms.** See section 2.
- **The owner as bottleneck.** Questions come with a recommended option and
  `/agent go`; agents ask only when the answer changes the implementation.
- **A runaway agent.** The separate Windows user, the scrubbed environment and
  the guard hook, then containers on the server.

## As built

Nothing yet.
