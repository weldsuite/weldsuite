# WeldReach warmup: WeldSuite's own warmup network

Status (2026-10-13): built on branch `claude/weldsuite-cold-email-platform-72f54d`
(PR #1115), not deployed; Phase W0 checks against real mailboxes are still open.
Migrations (master 0056, tenant 0210) were generated with the owner's go-ahead.
Replaces the Mailpool warmup that WeldReach uses today
(docs/plans/weldreach.md, "Mailboxes, domains and warmup"). WeldReach is not
live yet, so WeldSuite's warmup is the only warmup from the first release:
there is no Mailpool fallback and no migration of warming mailboxes.
Tables need the owner's go-ahead before their migration is generated.

## What warmup is, and what makes it work

A new mailbox on a new domain has no sending reputation. Warmup builds one by
having the mailbox send a slowly growing number of normal-looking emails that
get *positive engagement*: the recipient opens them, pulls them out of spam if
needed, marks some as important, and replies. Mailbox providers (Google,
Microsoft) read those signals and start trusting the sender.

A warmup network is a pool of mailboxes that do this for each other. Each
mailbox in the pool both **sends** warmup emails and **engages** with the ones
it receives. Engaging means logging in to the recipient mailbox (IMAP) and
acting on the message.

What makes a network good:

1. **Size and diversity of the pool.** Many mailboxes, on many domains, at
   different providers. A small pool that only emails itself gives weak signals
   and can look like a ring.
2. **Natural behaviour.** Varied content, timing, thread lengths and reply
   rates. Providers actively look for warmup patterns (fixed tags, templated
   text, mail only within a closed group).

## Approach (owner's decisions, 2026-10-13)

- **The pool is WeldReach's own mailboxes**, across all approved workspaces. No
  WeldSuite seed mailboxes: the first customer needs a lot of inboxes, and the
  network starts warming with those.
- **Cross-workspace warming**: every customer's mailboxes take part, and the
  access terms say so.
- **Content in English.**
- **Health gate**: at least 14 days of warmup **and** an inbox-placement rate of
  at least 85% over the last 3 days, with no login errors.
- **No Mailpool warmup**: neither as fallback nor alongside. The Mailpool warmup
  code is removed in the same change.

Because every engagement shows where the email landed (inbox or spam), the
network also measures inbox placement per mailbox. Mailpool only gave us its
own counters. That rate is the health signal above and is shown to the customer.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | A new worker `apps/workers/reach-warmup-worker` (cron + queues, no public API). It is cross-workspace background work with many SMTP/IMAP sessions; keeping it out of reach-api isolates load and failures. |
| Data | **Master DB**: the pool and the warmup messages span workspaces, and keeping them in master means the engine never wakes tenant databases on a timer (AGENTS.md). |
| Credentials | Each pool mailbox's SMTP/IMAP login, sealed with a dedicated key `WELDREACH_WARMUP_KEY` in the master pool table. reach-api writes them when a mailbox is created, updated or deleted. They are WeldSuite's own (Mailpool mailboxes on WeldSuite's Mailpool account). |
| Protocols | SMTP via `@weldsuite/smtp` (exists). IMAP via a new `@weldsuite/imap` package over `cloudflare:sockets` (993, implicit TLS) with password LOGIN, which covers the v1 inbox types (Mailpool `google` and `shared`). XOAUTH2 comes later with Outlook inboxes. |
| Identifying warmup mail | No visible tag. Each warmup email's `Message-ID` is generated and stored; the engager finds it with `UID SEARCH HEADER Message-ID`. Nothing in subject or body marks it as warmup. |
| Content | English only: a corpus of natural business email threads (2–4 messages each) generated with `@weldsuite/ai` and stored in R2, refreshed monthly. WeldSuite pays for it; customers are not charged credits. Plain text, no links, names filled in per pair. |
| Volume | Warming: 2 a day on day 1, growing to about 40 a day by day 14. After that, maintenance: 10–15 a day, kept running while the mailbox sends campaigns. Replies on 30–45% of threads. |
| Pairing | Never within one domain. Spread each mailbox's traffic across as many other domains as possible, mix `google` and `shared` mailboxes, prefer other workspaces when the pool has them, a cool-down per pair, and receiving roughly equal to sending. |
| Minimum pool | The planner needs mailboxes on **at least 3 domains**. Below that, warmup waits, and the Mailboxes screen says it is waiting for more mailboxes. |
| Health gate | 14 days of warmup and at least 85% inbox placement over the last 3 days, with no login errors. Replaces Mailpool's "healthy" report. |
| Cross-workspace | Agreed. The emails are synthetic (no customer data); new access term, terms version bumped. |
| Kill switch | Flagship flag `weldreach-warmup` (default on), separate from `weldreach-sending`. |
| Price | Included in the $5 per inbox. |

## How the engine works

```
cron (every 5 min) ─▶ planner (master) ─▶ reach_warmup_messages (scheduled)
cron (every min) ─▶ due messages ─▶ queue warmup-send ─▶ SMTP from sender mailbox
                                       └─▶ schedule engagement (+10–120 min)
cron (every min) ─▶ due engagements ─▶ queue warmup-engage ─▶ IMAP on recipient:
       find by Message-ID in INBOX / Junk → move to INBOX if in spam → \Seen,
       sometimes \Flagged → maybe schedule a reply (recipient → sender, same thread)
daily ─▶ cleanup (IMAP delete warmup threads older than 14 days) + stats rollup
```

**Planner** (runs a few times a day, master DB only):
- For each active pool mailbox, compute today's target from its ramp day, and spread the sends over business hours in its timezone with random gaps.
- Pick recipients under the pairing rules above.
- Pick a thread from the corpus.
- Skip mailboxes while the pool has fewer than 3 domains.

**Sender** (queue consumer):
- Opens the sender's sealed SMTP login and builds the message: corpus text with names filled in, the stored `Message-ID`, threading headers for replies.
- Sends through `@weldsuite/smtp` and records the result.
- A failed login pauses that mailbox in the pool and reports it to reach-api.

**Engager** (queue consumer):
- IMAP login to the recipient, `LIST` with SPECIAL-USE to find the Junk/Spam folder.
- Searches INBOX and Junk for the stored `Message-ID` and records where the email landed: `inbox`, `spam` or `missing` (not found after 3 attempts over 6 hours).
- Moves the email to INBOX if it landed in spam, marks it `\Seen`, and adds `\Flagged` about 20% of the time.
- Decides whether to reply. A reply is a new scheduled message in the same thread, sent the other way.

**Cleanup**: deletes warmup threads older than 14 days from both mailboxes, so they stay light. The `reach_warmup_messages` rows are kept for 30 days.

## Data model

### Master DB

**`reach_warmup_mailboxes`** (the pool)
- `id`, `workspaceId`, `clerkOrgId`, `tenantMailboxId`
- `email`, `domain`, `mailboxType` (`google | shared`), `timezone`
- `status`: `waiting | warming | maintaining | paused | error | removed`
- `startedAt`, `rampDay`, `dailyTarget`
- `smtpCredentials`, `imapCredentials`, sealed with `WELDREACH_WARMUP_KEY`
- `stats` jsonb: sent and received over 7 days, inbox / spam / missing counts, spam rescues, last error
- `pausedReason`, `lastLoginError`, `updatedAt`

**`reach_warmup_messages`**
- `id`, `threadId`, `step`, `fromMailboxId`, `toMailboxId`, `corpusThreadId`
- `messageIdHeader` (unique), `inReplyTo`
- `scheduledAt`, `sentAt`, `status` (`scheduled | sent | failed | engaged | missing`)
- `engageAt`, `engageAttempts`, `placement` (`inbox | spam | missing`), `actions` jsonb (moved, seen, flagged, replied), `error`
- Indexes on (`status`, `scheduledAt`), (`status`, `engageAt`) and `messageIdHeader`.

### Tenant DB

`reach_mailboxes.warmupDay` / `warmupStatus` stay. A new `warmupInboxRate` (numeric) is filled in by the existing daily `reach_warmup` sweep, which reads the master stats for that workspace's mailboxes. That is one tenant visit a day, as today.

## Changes in reach-api and elsewhere

- **Mailbox lifecycle** (`services/mailboxes.ts`, `services/warmup.ts`):
  - create: add the mailbox to the pool (sealed logins, status `waiting` or `warming`);
  - delete: remove it from the pool;
  - pause: pause its warmup too.
- **Remove Mailpool warmup**:
  - the client's warmup methods and types (`addToWarmup`, `listWarmup`, `getWarmup`, `startWarmup`, `pauseWarmup`, `removeFromWarmup`);
  - `ensureWarmupRunning`, the warmup lookup and Mailpool-health helpers in `services/warmup.ts`;
  - their tests.
- **Warmup sweep**: `processWorkspaceWarmup` reads the pool stats instead of Mailpool's warmup detail. It applies the new health gate and keeps the campaign ramp (10 → 30) as it is.
- **Inbound filter** (`email/handler.ts`): Mailpool forwards *all* incoming mail, warmup included, to the reply address. Before opening the tenant, look up the `Message-ID` and `In-Reply-To` in master `reach_warmup_messages`. On a match, drop the email, so warmup never appears in the reply inbox or stops a campaign.
- **Daily volume**: warmup and campaign sends share the mailbox. The send engine keeps its own caps; the planner keeps warmup at 40 a day or less, so the total stays far below Google's and Mailpool's limits.
- **Platform**:
  - the Mailboxes screen shows warmup day, inbox-placement % and spam rescues per mailbox, plus "waiting for more mailboxes" while the pool is too small;
  - the overview's mailbox health uses the new numbers (en + nl).
- **Admin console**: a "Warmup network" page.
  - Pool size by domain and mailbox type, today's volume, placement trend, mailboxes in error.
  - Pause a mailbox's warmup.
- **Access terms**: new term `warmup_network` ("Our outreach mailboxes take part in WeldSuite's warmup network: they exchange automatically generated emails with other WeldReach mailboxes."). Terms version bumped. Workspaces approved under the old version accept the new term the next time they open WeldReach.

## Rollout

WeldReach has no live mailboxes yet, so there is nothing to migrate.

1. Ship the network as the only warmup, with the Mailpool warmup code removed.
2. The first customer's mailboxes start warming as soon as the pool has mailboxes on 3 domains. Suggest that customer spreads its inboxes over several domains: that is good for deliverability anyway, and the pool needs it.
3. Watch placement for the first two weeks (admin console page) before their campaigns start. Mailpool's inbox-placement test API gives an independent check.

## Delivery

- **Phase W0 (checks, no merge)**:
  - Does Mailpool put new mailboxes into its warmup automatically? If so, turn it off per mailbox or account, so mailboxes aren't warmed twice.
  - Do Mailpool's `google` and `shared` mailboxes accept IMAP logins from Cloudflare egress? Same risk as SMTP.
  - Gmail IMAP behaviour: SPECIAL-USE, MOVE, search on `Message-ID`.
- **Phase W1**: `@weldsuite/imap`
  - LOGIN, CAPABILITY, LIST (SPECIAL-USE), SELECT, UID SEARCH HEADER, UID STORE, UID MOVE (falling back to COPY + `\Deleted` + EXPUNGE), LOGOUT, literals, timeouts;
  - tested against a scripted fake server, like `@weldsuite/smtp`.
- **Phase W2**: master tables + migration (**needs approval**), the `WELDREACH_WARMUP_KEY` secret, and pool registration from reach-api.
- **Phase W3**: `reach-warmup-worker`: planner, sender, engager, replies, cleanup, stats, the English content corpus (generation script + R2), and the kill-switch flag.
- **Phase W4**:
  - reach-api switch-over: health gate, inbound filter, lifecycle changes, removal of the Mailpool warmup code;
  - platform warmup stats and the admin console network page;
  - the terms update.
- **Phase W5**: first customer (Rollout 2–3).

## Tests

- **`@weldsuite/imap`**:
  - reply parsing (literals, untagged responses, partial chunks);
  - folder lookup by SPECIAL-USE, search, move with fallback, timeouts.
- **Planner**:
  - ramp per day and timezone spread;
  - pairing rules: never same domain, domain spread, type mix, pair cool-down, send/receive balance, cross-workspace preference;
  - waits below 3 domains.
- **Sender and engager**:
  - landed in inbox, landed in spam then moved, missing then retried then `missing`;
  - reply scheduling and threading headers, login failure pausing the mailbox.
- **reach-api**:
  - the inbound filter drops forwarded warmup mail and lets real replies through;
  - the health gate;
  - lifecycle registration and removal in the pool;
  - no Mailpool warmup calls left.
- **Corpus**: no links or tracking, placeholders resolved.

## Risks

- **One customer's mailboxes warming each other.** At first the pool is mostly one workspace, on Mailpool infrastructure, emailing itself. Providers can read a closed group as a ring.
  - Mitigation: many domains, mixing `google` and `shared` mailboxes, varied content and timing, a balanced send/receive ratio.
  - Placement is measured from day one, and warmup pauses when it drops.
  - If placement disappoints, adding WeldSuite seed mailboxes at other providers is the lever (follow-up, not v1).
- **No Microsoft mailboxes in the pool.** Recipients at Microsoft 365 / Outlook don't take part, so the network neither builds reputation there directly nor measures placement there. Outlook inboxes in WeldReach (a follow-up) would close that gap.
- **Providers detecting warmup.** A warmup that gets detected hurts the mailboxes it was meant to help. Mitigation: no visible tags, generated content, human-like timing and reply rates, placement monitoring with automatic pause.
- **Terms of the mailbox providers.** Automated engagement is a grey area under Google's terms (the whole warmup industry operates in it). Every mailbox in the pool is WeldSuite's own Mailpool mailbox.
- **IMAP logins from Cloudflare.** Google may block sign-ins from Cloudflare egress IPs, as for SMTP (Phase W0).
- **Credentials in the master DB.** Mitigation:
  - a dedicated key, never returned by any API, rotation by re-sealing;
  - registered as sensitive columns.
- **Ongoing work.** Corpus refresh and tuning the ramp and pairing as the pool grows.

## Owner answers (2026-10-13)

1. **Seed pool**: none. One customer needs a lot of inboxes; the network warms with those.
2. **Corpus language**: English.
3. **Cross-workspace warming** with a new access term: agreed.
4. **Health gate**: as recommended (14 days, at least 85% inbox placement over 3 days).
5. **Mailpool warmup**: not kept as a fallback; removed.

## As built (2026-10-13)

- **Code**: `@weldsuite/imap` (packages/core/imap), `@weldsuite/reach-domain` (packages/domains/reach: warmup numbers and pool operations), `apps/workers/reach-warmup-worker` (planner, pairing, dispatch, send, engage, daily, stats, cleanup, login recheck, corpus), reach-api switch-over, platform Warmup column + overview placement, admin console `/warmup`.
- **Volume**: the ramp (2 → 40) and maintenance (10–15) are *total* warmup sends a day. Replies come on top of the threads a mailbox starts, so the planner starts `round(total / 1.6)` new threads (25 at the peak).
- **Weekends**: no new threads on Saturday and Sunday in the mailbox's timezone; replies due then move to Monday morning.
- **Ramp day**: advanced by the 02:30 UTC run for mailboxes that sent warmup mail the previous UTC day.
- **Auto-pause**: a maintaining mailbox below 60% inbox placement over 3 days (minimum sample) is paused (`low_inbox_rate`) and resumed after a 3-day cool-off; it is paused again if placement is still low. User (`paused_by_user`), staff (`paused_by_staff`), Mailpool (`mailbox_suspended`) and domain pauses are never lifted by the worker.
- **Login failures**: a failed SMTP/IMAP login puts the pool mailbox in `error` (`login_failed`) and marks the workspace due so reach-api pauses the tenant mailbox the same day; a successful login (send, engage, cleanup or the 30-minute recheck) clears it.
- **Cleanup on Gmail**: deleting in INBOX only archives, so cleanup moves warmup mail to Trash and deletes it there.
- **Corpus refresh**: the replaced set is kept as `previous.json`, so mail planned before a refresh still renders.

## Follow-ups (not in this plan)

- Seed mailboxes at other providers, if placement in a pool of mostly one customer disappoints.
- XOAUTH2 in `@weldsuite/imap` and Outlook mailboxes in the pool, together with Outlook inboxes in WeldReach.
- More corpus languages.
