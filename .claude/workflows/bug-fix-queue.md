# Bug-Fix Queue, live order of work

> Strict serial. One PR open at a time. Bundles = single PR fixing multiple tasks. See [bug-fix-and-feature-workflow.md](./bug-fix-and-feature-workflow.md) for the rules.
>
> **Assignee:** Gert (`user_3984pBydzNbnt1KVhOHY5fZYzqq`)
> **Last refresh:** 2026-05-22, open todos: 158 (52 high, 59 medium, ~47 low/none) + 1 in_progress + 7 backlog.

---

## Legend

- 🟥 **high**  🟧 **medium**  🟨 **low**
- 🧷 **bundle**, single PR fixes multiple WeldSuite tasks
- 🛑 **gate likely**, expect to hit a hard stop (schema / entity-events)
- ⏳ status, `queued` → `in-progress` → `pr-open` → `done`

---

## ── Active ──

Nothing in flight. Pick PR #1 below.

---

## ── Queue (highest priority first) ──

### PR #1 🧷 Avatar consistency bundle  🟥 high
**Status:** queued | **Estimated**: 1 PR, frontend-only

Root cause hypothesis: avatar URL/resolver helper isn't used consistently, different code paths build avatar URLs differently per surface.

| Task | Title | Module |
|---|---|---|
| `task_mooflyhkrpm9fu2u` | avatars verkeerd in WeldMail (menu, details, contact panel) | WeldMail |
| `task_mon1xkcxj4g1x83z` | teammember avatars verkeerd in details panel | Platform |
| `task_mp5wyw9tsy2ysszh` | preview scherm avatars verkeerd in WeldMeet | WeldMeet |
| `task_mng31kp54gekuw1f` 🟧 | weldflow assignee avatars verkeerd | WeldFlow |

**Specialist chain:** `frontend-platform` (+ possible cross-check with `weldmail`, `weldmeet-meetings`).

---

### PR #2 🧷 Realtime cache-invalidation bundle  🟥 high
**Status:** queued | **Estimated**: 1 PR, touches @weldsuite/realtime + React Query invalidations

Root cause hypothesis: client mutations don't trigger immediate cache invalidation + sidebar counters poll instead of subscribing.

| Task | Title | Module |
|---|---|---|
| `task_mp2q1hz8md25hce2` | teammember aanpassingen niet instant zichtbaar bij andere users | Platform |
| `task_momy6w7owxs5hlph` | mini-sidebar notification counts updaten pas na refresh | Platform |
| `task_mp4jz339w5bjfr9w` | WeldChat notifications komen niet in app-icon mini-sidebar | WeldChat |

**Specialist chain:** `frontend-platform` + `realtime-worker` review.

---

### PR #3 🧷 WeldMeet camera/video bundle  🟥 high
**Status:** queued | **Estimated**: 1 PR, weldmeet-meetings + frontend-platform

Root cause hypothesis: video track state isn't restored when toggled / when route changes / when guest sends action.

| Task | Title |
|---|---|
| `task_mp5wxyqptmmkejfy` | camera bug |
| `task_mp4jp3l983ft2np4` | camera off → on = zwart scherm, geen avatar |
| `task_mp4jodml80ugs0fv` | raise hand van guest naar host werkt niet |
| `task_mo8ifmze297ilpei` | meeting verdwijnt als je naar andere app gaat |

**Specialist chain:** `weldmeet-meetings` (+ `frontend-platform`).

---

### PR #4 🧷 Activity page bundle  🟥 high
**Status:** queued | **Estimated**: 1 PR, small

| Task | Title |
|---|---|
| `task_mp749neib2vtrurr` | channel names niet getoond in activity page |
| `task_mox1x0e7e6mnssnq` | "last activity" datum altijd "--" |

**Specialist chain:** `backend-app-api` (joins) + `frontend-platform`.

---

### PR #5 🧷 CRM panel header bundle  🟥 high
**Status:** queued

| Task | Title |
|---|---|
| `task_mp5koomq8eqs43v3` | contact page toont niet alle contacten |
| `task_mp4edihu8ccquvv8` | email/phone icon buttons werkend maken in panel header |
| `task_movy7rmcpjchyd2s` | custom field address input met suggest menu |

**Specialist chain:** `weldcrm` + `frontend-platform`.

---

### PR #6 🧷 Notifications system  🟥 high
**Status:** queued | 🛑 gate likely (entity-events catalog)

| Task | Title |
|---|---|
| `task_moojfeetsi1gbcfu` | Outlook-style notifications (meeting in 15m, task assigned, etc.) |
| `task_mp2qp8y55e8445ej` | teammember invite verschijnt in notifications panel |
| `task_mp08c3udi2cnmufn` 🟧 | notifications popups in weldsuite |

**Specialist chain:** `weldagent-ai` (events?) + `backend-app-api` + `frontend-platform`.

---

### PR #7 🛑 Pipeline templates in CRM settings  🟥 high
**Status:** queued | 🛑 gate likely (DB schema, `crm-templates` already in your working tree!)

| Task | Title |
|---|---|
| `task_movy7a7869chvvvz` | pipeline templates in crm settings |

> Already partially in progress, your `git status` shows `packages/core/db/src/schema/crm-templates.ts` and matching routes uncommitted. **This is technically the active task already**; finish/commit before starting anything else.

**Specialist chain:** `database` (approval) + `backend-app-api` + `frontend-platform`.

---

### PR #8 🧷 Domain panel & weldhost bundle  🟥 high
**Status:** queued

| Task | Title |
|---|---|
| `task_mon222tuairmba20` | domain details panel zelfde component als customer panel |
| `task_molyrea42ctliwg4` | commenten in domain panel → WeldChat |
| `task_mord6pmhvoqo9pw4` | chat in weldhost detail panel werkend |
| `task_mossruy0lxp1o1cl` 🟧 | domains zoeken werkt niet |

**Specialist chain:** `weldhost-domains` + `frontend-platform`.

---

### PR #9 🧷 Calendar / booking bundle  🟥 high
**Status:** queued

| Task | Title |
|---|---|
| `task_molxcjzxoq9tvlvt` | calendar cards laden traag bij navigatie |
| `task_movy6f1yab03uzfv` | task cards in calendar op priority color |
| `task_mp5k7ztwz6zq0ske` | schedule call form → contact auto-aanmaken |
| `task_movy6890nr9nb6l2` | booking email goed maken |
| `task_moevjee8m8hsunjc` | google calendar integration werkt niet |
| `task_mnhmx9qo8c6fro3w` | events met WeldDrive file attachment |
| `task_movy6t2wbzwye4a7` | motion-style auto-scheduling |

⚠️ This bundle is large. Triage may suggest splitting into 2: **(a) calendar bugs**, **(b) calendar features**.

**Specialist chain:** `weldmeet-meetings` (covers calendar/booking) + `frontend-platform`.

---

### PR #10 🧷 WeldChat structure  🟥 high
**Status:** queued | 🛑 gate likely (schema + entity-events)

| Task | Title |
|---|---|
| `task_mp2q40sxtkcc918q` | role-based channels in WeldChat |
| `task_moq8vyybretnwpww` | agents in public channels |
| `task_mo7j5mrnl9qr47sc` | projects/customers/tasks koppelen aan channels |

**Specialist chain:** `database` (approval) + `backend-app-api` + `weldagent-ai`.

---

### Singletons (high priority, no obvious bundle)

> Run one at a time after the bundles above.

| # | Task | Title | Note |
|---|---|---|---|
| 11 | `task_mpejyr0hi925l6ax` | scroll bug in "my tasks" page | small |
| 12 | `task_mp4dh2hi7hw7fhpd` | categories customizable | 🛑 likely schema |
| 13 | `task_mosozqytdmavq0m0` | invited teammembers tonen (zoals Clerk) | Clerk API integration |
| 14 | `task_momwydxnowk0h2vo` | phone numbers page "failed to load" | Twilio backend |
| 15 | `task_molnwnko5cwrusq7` | inbound calls in CRM | larger feature |
| 16 | `task_mn9g1bomtnv65jnm` | **GLOBAL** "unsaved changes" warning across hele WeldSuite | platform-wide |
| 17 | `task_moka8xh0dpxskfnr` | Excel-style WeldFlow tables | large refactor |
| 18 | `task_mo8hiyknz78yf1i1` | breakout rooms in WeldMeet | feature, large |
| 19 | `task_mo5v60qsbryonyup` | teammember work days/hours | small |
| 20 | `task_mnnkj0qqd17yxlav` | meeting/call intelligence linked to contacts | data join |
| 21 | `task_mnalejbqkpieuozf` | teammember overview page + admin view | feature |
| 22 | `task_mnalhaco3llsfwjk` | groep calls + groep chats | WeldChat feature |
| 23 | `task_mn9ge5feju82c4fc` | contact panel buttons per geïnstalleerde app | feature toggle logic |
| 24 | `task_mndn09fpvnkzxgpg` | mobile DMs overview "No message yet" bug | mobile-expo |
| 25 | `task_mn9g91lvvnjh6ucl` | mobile add email account werkend | mobile-expo |
| 26 | `task_mo315gz2dx74wggs` | mobile websites widget shadow (Safari) | helpdesk-widget |
| 27 | `task_mn6gmldqg7vgjbno` | helpdesk widget, premature "new conversation" alert | helpdesk-widget |
| 28 | `task_mn1ugm8oedxglaoa` | messages overview names/preview text | WeldChat |

---

## ── In progress (already in WeldSuite) ──

| Task | Title | Note |
|---|---|---|
| `task_mo35kz3u7abmh1uo` | Github connection (feature, due 2026-05-16) | overdue, pick up or de-scope |

---

## ── Backlog (7) ──, re-prioritise after high-pri queue drains

- `task_mlwes1n27yb3eje3` low, presence "who's on which page" (Discord-style)
- `task_mlwvp8m1ivam3iih` low, Asana integration
- `task_mlwcffnet92t0y9j` medium, task history
- `task_mlweqhnlkwhd7ovf` medium, task history (duplicate?)
- `task_mlvddjrib51fsaf5` medium, Roadmap page
- `task_mltileh2szul1jfe` low, connect GitHub repo to WeldFlow
- `task_mltjamzyajwyfrt6` medium, Excel-style tables in projects (overlap with #17)
- `task_mltu0gjhdss9v086` medium, all-avatars fix (overlap with PR #1)

> ⚠️ Several backlog items overlap with high-priority items. When PR #1 (avatars) closes, mark `task_mltu0gjhdss9v086` done too. When PR #17 (excel tables) closes, mark `task_mltjamzyajwyfrt6` done.

---

## ── Medium priority (59) ──

Drain after the 28 high-pri items above are closed. Likely bundles when we re-evaluate:

- **Documents / WeldDrive**, print, paginated view, comments, drive download (`task_mp9qnmjk7yuxt043`, `task_mp9qna25ylc3vhyh`, `task_mp9qxieqweidqb5o`, `task_mosmf95wooytk4lo`)
- **Whiteboard comments** (`task_mp9qynviulupq2z5`)
- **WeldChat structural**, agents tagging, slash commands, reminders, search, announcements, voice channels, permissions per channel (~10 tasks)
- **CRM lists / customers**, public/private lists, customer merge, shared customer viewing (~3 tasks)
- **Auto-flows**, done-task cleanup, in-progress→in-review after N days (`task_mp9qq9abzxdx6wvv`)

---

## How to use this file

1. The agent picks PR #1 (or the next un-`done` row).
2. Comments on every WeldSuite task in that PR with the PR URL after merge.
3. Updates the **Status** column here from `queued` → `in-progress` → `pr-open` → `done`.
4. On merge, deletes the row (or strikes it through) and pops the next PR.
5. Refresh from WeldSuite every ~10 closed PRs to catch new tasks Gert filed in the meantime.
