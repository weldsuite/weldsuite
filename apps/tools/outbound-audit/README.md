# outbound-audit

Read-only audit that answers one question per environment: **is anyone sending
cold email through WeldSuite right now?** It is Phase 1 of
[docs/plans/weldmail-outbound-abuse.md](../../../docs/plans/weldmail-outbound-abuse.md):
real numbers to set the outbound guard's thresholds with, before any limit is
enforced.

For every active workspace (or one, with `--workspace`) over the last 30 days
(`--days`) it reports:

1. **WeldMail sends**: SENT copies per mailbox per UTC day: messages, envelope
   recipients (to + cc + bcc), distinct recipients, recipient domains, new
   threads vs replies vs forwards, peak hour.
2. **First contact**: recipients who had never written to the workspace when
   the mail went out, and how many of them wrote back later.
3. **Template repetition**: new-thread bodies fingerprinted with
   `@weldsuite/mail-domain/outbound/fingerprint` (SimHash, near-duplicates
   within Hamming distance 3 count as one template), ranked by distinct
   first-contact recipients.
4. **Content signals**: share of sends the outbound content screen
   (`screenOutboundContent`) scores 3 or more, with the cold / bulk / phishing
   flags.
5. **Paths without a SENT copy**: CRM sequence `send_email` steps (and
   enrolments) and WeldConnect `send_email` actions per day.
6. **Cloudflare** (optional, `--cloudflare`): Email Sending analytics per
   sending domain (statuses, failures, `isSpam`).

It ranks workspaces by a suspicion score and shows, per workspace, which of the
plan's proposed limits the traffic would have hit.

## It is read-only

- Every tenant query runs inside a `BEGIN READ ONLY` transaction with a
  300-second statement timeout. Nothing is written anywhere.
- The master DB is only read (`workspaces` joined to `plans`).
- Cloudflare is only asked for zone ids and analytics.
- Tenants are audited one at a time over a single connection each.

## Running it

From the repository root (or `pnpm audit:outbound` inside this folder):

```bash
pnpm audit:outbound -- --env test --out reports/test.md --json reports/test.json
pnpm audit:outbound -- --env production --cloudflare --out reports/prod.md
pnpm audit:outbound -- --workspace org_2abc --days 7          # one workspace, markdown to stdout
pnpm audit:outbound -- --help
```

The script runs with this folder as its working directory: relative `--out` /
`--json` paths land here, and `reports/` is git-ignored. Progress goes to
stderr, the report to the file or stdout.

### Environment variables

Point them at **one environment at a time** (test or production). Put them in
`apps/tools/outbound-audit/.env` (git-ignored, read by `dotenv`), export them in
your shell, or run through Doppler, e.g.
`doppler run --config <prd|tst> -- pnpm audit:outbound -- --env production …`.

| Variable | Needed | What for |
|---|---|---|
| `MASTER_DATABASE_URL` | always | Lists the workspaces and their tenant databases. |
| `DATABASE_ENCRYPTION_KEY` (+ `DATABASE_ENCRYPTION_KEY_V2`) | when tenant URLs are stored encrypted (production) | Decrypts `workspaces.database_url`, as the tenant migration runner does. |
| `NEON_API_KEY` | when a workspace has no stored URL | Fallback: asks Neon for the connection string. |
| `CLOUDFLARE_API_TOKEN` | `--cloudflare` | Token with **Account Analytics Read** and **Zone Read** on WeldSuite's Cloudflare account. |
| `MAIL_STORE_ADMIN_URL` | `--mail-source export` or `auto` | The mail-api origin to call for mailbox-store admin requests, e.g. `https://mail-api-test.weldsuite.org` (no trailing slash). |
| `OUTBOUND_ADMIN_SECRET` | `--mail-source export` or `auto` | Shared secret for mail-api's staff API (`apps/workers/mail-api/src/lib/admin-auth.ts`), sent as `x-admin-secret`. Same secret the admin console and `routes/internal-mail-store`/`routes/internal-outbound` check against — ask ops for the value, never guess or reuse a different worker's secret. |
| `MAIL_STORE_ADMIN_EMAIL` | `--mail-source export` or `auto` | The acting operator's email, sent as `x-admin-email` so mail-api's audit log lines (never this tool's own output) can attribute the calls. |

`CF_ACCOUNT_ID` is not needed: Email Sending analytics are zone-level datasets.

### Options

| Option | Default | |
|---|---|---|
| `--days <n>` | 30 | Window, 1–365 days. Cloudflare keeps 31 days, so its section is capped at 31. |
| `--workspace <id>` | all | Workspace id, slug or Clerk org id. |
| `--out <file>` | stdout | Markdown report. |
| `--json [file]` | none | Full JSON report (every mailbox-day, top 20 templates and domains). Without a file it goes to stdout instead of the markdown. |
| `--cloudflare` | off | Add Cloudflare Email Sending analytics. |
| `--redact` | off | Replace workspace names, mailboxes and domains with labels and drop template text, to share aggregate numbers. |
| `--top <n>` | 5 | Templates, domains and busiest days listed per workspace in the markdown. |
| `--env <label>` | none | Label printed in the report header. |
| `--mail-source <s>` | `postgres` | Where WeldMail sends are read from: `postgres`, `export` or `auto` — see below. |

The exit code is 1 when a workspace could not be audited (the report still lists
the others and names the failure), 2 for bad options.

### Running it against object-mode workspaces

WeldMail is moving mailboxes behind a Durable Object store, one workspace at a
time (`docs/plans/weldmail-mailbox-store-design.md`, flag
`weldmail-mailbox-store`). In `object`/`object-only` mode a workspace's tenant
`mail_messages` table can be a lagging secondary or, in `object-only` mode,
never written at all — reading it straight out of Postgres would silently
undercount or miss that workspace's sends. This tool runs locally against
Neon, not inside a Cloudflare Worker, so it cannot address a mailbox's Durable
Object directly; instead it calls mail-api's staff API
(`apps/workers/mail-api/src/routes/internal-mail-store/index.ts`, the same
secret-plus-identity auth as the admin console) to page that mail through
`GET /internal/mail-store/export`.

`--mail-source` picks how a mailbox's sends are read:

- **`postgres`** (default): unchanged — `mail_messages` for every mailbox, no
  mail-store admin calls at all. Safe for every environment today.
- **`auto`**: for each workspace, asks `GET /internal/mail-store/status/all`
  which mode each mailbox is stored in. Mailboxes in `object`/`object-only`
  mode are read through the export client instead of Postgres; everything
  else keeps today's path. If the mode lookup itself fails (bad URL, network,
  mail-api down), that workspace falls back to pure Postgres and the report
  notes it rather than failing the run.
- **`export`**: forces every mailbox of every audited workspace through the
  export client, regardless of its stored mode. Useful to sanity-check the
  export path itself, or for a workspace already known to be fully
  object-backed.

```bash
pnpm audit:outbound -- --env test --mail-source auto --workspace ws_2abc
```

Needs `MAIL_STORE_ADMIN_URL`, `OUTBOUND_ADMIN_SECRET` and
`MAIL_STORE_ADMIN_EMAIL` (above) for `export`/`auto`; `postgres` needs none of
them.

Two things are different for mail read this way, both called out in the
report's per-workspace notes when it happens:

- **No body content.** The export route never returns message bodies (the
  object has none to give), so template fingerprinting and the content screen
  see no content for these sends — they're still counted, just not clustered
  or scored.
- **First contact** is still computed from `mail_correspondents` /
  `mail_messages` in Postgres (unaffected by this task): for an `object-only`
  workspace, the trigger that keeps `mail_correspondents` current no longer
  fires on inbound mail, so that number can be stale for those workspaces
  until the ledger work lands. The sent-side counts this tool exists for are
  unaffected.

## Privacy

**The output holds customer data**: workspace names, mailbox addresses,
recipient domains and short template snippets. Never commit it, never paste it
into a ticket, PR or chat, keep it on your own machine and delete it when you
are done. The tool prints this reminder at the end of every run.

What the report deliberately leaves out:

- **No recipient addresses**: recipients are only counted; the report shows
  their domains.
- **Template text is tokenised**: the snippet is the normalised body (names,
  companies, addresses, links and numbers replaced by tokens), at most 120
  characters; the subject has the recipients' names, companies, addresses,
  links and phone numbers replaced, at most 80 characters.
- WeldConnect step errors (which can quote an address) never leave the
  database: SQL reduces them to the "X of N runs failed" count.
- Driver errors are scrubbed of connection strings and Neon hosts.
- `--redact` additionally replaces workspace names, ids, mailboxes and every
  domain with labels and drops snippets and subjects.

## How the numbers are made

- **SENT copies**: `mail_messages` with `source = 'sent'` sent in the window,
  excluding scheduled rows that have not gone out (`send_status` `scheduled`,
  `cancelled` or `failed`) and drafts. Copies the user deleted afterwards still
  count: deleting a SENT copy does not unsend it. Recipients are counted per
  envelope (to + cc + bcc), as Cloudflare does.
- **First contact**: a recipient is a first contact for a send when no mail from
  that address reached the workspace before the send. The source is
  `mail_correspondents.first_inbound_at` when that table exists (outbound-guard
  migration), otherwise received mail in `mail_messages`
  (`source IS DISTINCT FROM 'sent'`, the same rule as the migration's backfill;
  the report notes which one it used). The workspace's own mailboxes and its
  own custom mail domains are never first contacts. "Wrote back later" is the
  share of first contacts whose first inbound mail came after their first send
  in the window: cold mail gets few replies.
- **Templates**: only new threads (no `in_reply_to` / `is_reply`, not a
  forward) are fingerprinted, with the recipients' names, address local parts
  and company labels as merge-field tokens. Bodies under 12 words are skipped.
  The plan's thresholds are shown: 10 distinct first-contact recipients on one
  day queues an AI review, 25 caps a cold-outreach template.
- **Content screen**: run on every send with recipients; "flagged" means a
  score of 3 or more, as in the guard's risk score.
- **CRM sequences** store no SENT copy. Each run is a `workflow_executions` row
  with `trigger_data.source = 'sequence_enrollment'`; its `send_email` steps are
  counted per day (completed = sent). The recipient is taken to be the enrolled
  contact (`sequence_enrollments.customer_snapshot.email`), which is where
  sequence mail goes; that drives the sequence first-contact numbers.
- **WeldConnect** stores no SENT copy and no recipients, so only counts are
  possible: `send_email` steps of every other workflow run (editor test runs
  excluded). A step inside a loop writes one row for all iterations, so its
  `output.runs` is counted, and a loop that carried on past failures counts its
  successful runs. Gmail sends (`gmail.send_email`) go through the user's own
  Gmail account, not WeldSuite's Cloudflare account, and are not counted.
- **Cloudflare**: GraphQL `emailSendingAdaptiveGroups`
  ([docs](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)),
  one query per sending domain (the domains of the workspace's mailboxes that
  sent, plus its `mail_domains`), grouped by date, status, `isSpam`,
  `isLastEvent` and event type. Zone ids come from
  `mail_domains.cloudflare_zone_id`, else `findZoneIdByName` walking up to the
  registrable domain (the shared `weldmail.com` zone is filtered to the
  workspace's own subdomain). Emails are counted by their last event; a status
  containing fail, bounce, reject, drop or error counts as failed. What
  `isSpam` means for outbound mail is still an open question in the plan. The
  `cloudflare` SDK has no GraphQL resource, so this one query uses `fetch`.
- **Proposed limits** compare the traffic with `OUTBOUND_DEFAULT_LIMITS` for
  the trust level the guard would compute today (`computeTrustLevel`, without
  bounce data, so never `trusted`). Windows are UTC calendar days and clock
  hours, not the guard's rolling 24 hours. CRM sequence and WeldConnect sends
  count towards the workspace's daily total only.

### Suspicion score

A ranking aid for staff, not a verdict and not the guard's risk score:

```
score = 10 × V × F × T × C × B
V = log10(1 + volume)            WeldMail envelope recipients + sequence + WeldConnect sends
F = first-contact share          of recipients whose status is known (WeldMail + sequences);
                                 0.5 when only WeldConnect sent ("assumed" in the report)
T = 1 + log10(1 + reach)         distinct first-contact recipients of the top template
C = 1 + flagged share            content screen score 3+
B = 1 + 10 × bounce share        only with --cloudflare
```

A workspace that only replies to people who wrote in scores 0 whatever its
volume; one template mailed to many strangers multiplies everything else.

## Development

```bash
pnpm --filter outbound-audit test         # vitest, fixture rows only, no database
pnpm --filter outbound-audit type-check
```

The aggregation, scoring and rendering (`mail-aggregate.ts`, `automation.ts`,
`limits.ts`, `cloudflare.ts`, `score.ts`, `assemble.ts`, `report.ts`,
`redact.ts`) are pure and unit-tested. `tenant-queries.ts` and `master.ts` hold
the SQL; `mail-store-client.ts` holds the mail-api admin HTTP client
(`--mail-source export`/`auto`, unit-tested with a mocked `fetch`); `index.ts`
wires them together.
