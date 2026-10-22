# A separate WeldMail zone for the test environment

Status: steps 1–4 implemented (2026-10-22); infra (step 0) and the move of existing test workspaces (step 5) pending. Touches [MAIL-007](https://github.com/weldsuite/weldsuite-documentation/blob/main/adr/MAIL-007-free-shared-weldmail-subdomain-per-workspace.md):
supersede or amend it once this lands.

## Problem

Test and production share the one `weldmail.com` Cloudflare zone, and a zone
has exactly one Email Routing catch-all. Today it points at
`weldsuite-mail-inbound` (production), because `MAIL_INBOUND_WORKER_NAME` is
set nowhere and every caller falls back to that name. So:

- Mail to a test workspace's `{slug}.weldmail.com` reaches the production
  inbound worker, finds no row in the production `mail_account_registry`, is
  accepted and dropped (`mail-inbound-worker/src/index.ts:189`). No bounce,
  no mail.
- Test and production workspaces share the zone's 30-domain cap (Email Routing
  + Email Sending combined). On 2026-10-22 it held 21: the apex plus 20
  workspace subdomains, test and production mixed. Nothing ever removes a
  workspace's subdomain, and test churns through workspaces.
- Provisioning failures are swallowed (`onboard.ts:348`, `partner-onboarding.ts:345`),
  and the tenant `mail_domains` row is written as `dnsStatus: 'verified'`
  regardless. Reported case: `maestro-test-workspace.weldmail.com` has no
  routing records and no sending subdomain, so Gmail bounces with "domain not
  found". Nothing has been provisioned on the zone since 2026-10-07.

## Decision

Test gets its own apex zone, `weldmail.org`, whose
catch-all routes to `weldsuite-mail-inbound-test`. Production keeps
`weldmail.com` and the whole 30-domain cap.

A subdomain of `weldmail.com` (e.g. `test.weldmail.com`) does not work:
it stays inside the `weldmail.com` zone and its single catch-all. Making it
a zone of its own needs Cloudflare's subdomain setup, which is Enterprise-only.

### Config shape

Two values per environment, nothing else:

| var | dev | test | production |
|---|---|---|---|
| `WELDMAIL_DOMAIN` | `weldmail.org` | `weldmail.org` | `weldmail.com` |
| `MAIL_INBOUND_WORKER_NAME` | `weldsuite-mail-inbound-test` | `weldsuite-mail-inbound-test` | `weldsuite-mail-inbound` |

- **Building** a domain (`{slug}.{apex}`, which zone to provision) reads
  `WELDMAIL_DOMAIN`.
- **Recognising** a shared domain (outbound cap, "no catch-all on shared
  domains", "is this a custom domain") uses a static list of both apexes,
  so the classification helpers and the platform UI need no env: a
  `*.weldmail.org` address is a shared-reputation address everywhere.
- `MAIL_INBOUND_WORKER_NAME` is set explicitly in production too, so no
  environment depends on the fallback again.

## Steps

### 0. Infra (manual, one-time — owner action)

1. Move `weldmail.org` to Cloudflare: add it as a zone on the WeldSuite
   account and switch its nameservers from Vercel DNS. It currently has an A
   record on Vercel and MX records on Mailgun EU: copy what is still needed,
   and note that enabling Email Routing replaces the apex MX records, so
   whatever receives `@weldmail.org` mail through Mailgun today stops.
2. Nothing else by hand: the first test provisioning run enables Email
   Routing, PUTs the catch-all to `MAIL_INBOUND_WORKER_NAME` and authorises
   Email Sending (`CloudflareDomainProvider.provisionDomain`). The
   workspace-worker token already has `Zone.Email Routing`; confirm it covers
   the new zone (account-scoped tokens do, zone-scoped ones don't).

### 1. Shared helper

`packages/clients/app-api-client/src/schemas/outbound-mail.ts` already owns
`isSharedWeldMailDomain`. Extend it:

- `SHARED_WELDMAIL_APEXES = ['weldmail.com', 'weldmail.org']`
- `isSharedWeldMailDomain(domain)` → true for either apex and their subdomains
- `weldMailDomainFor(slug, apex)` → `${slug}.${apex}`

and replace the copies:

- `apps/workers/mail-inbound-worker/src/lib/catch-all.ts:15` (`isSharedWeldMailDomain` duplicate)
- `apps/workers/mail-api/src/services/mail/domains.ts:48` and
  `apps/web/platform/app/settings/apps/weldmail/domains/page.tsx:25` (`isCustomDomain` = `!isSharedWeldMailDomain`)

### 2. Building the domain from `WELDMAIL_DOMAIN`

- `apps/workers/workspace-worker/src/services/mail-provisioning.ts:38`
  `MAIL_APEX_ZONE` → `env.WELDMAIL_DOMAIN`.
- `apps/workers/workspace-worker/src/workflows/provision-workspace.ts:360` and
  `routes/backfill-mail.ts:80` → `weldMailDomainFor(slug, env.WELDMAIL_DOMAIN)`.
- `apps/workers/mail-api/src/services/mail/weldmail.ts:58` `weldMailDomainFor`
  takes the env apex (all its callers already have `env`).
- `apps/workers/mail-api/src/services/mail/accounts.ts:27,251,259`:
  `BARE_WELDMAIL_DOMAINS` gains `weldmail.org`; the
  "own subdomain" check uses `isSharedWeldMailDomain` + the env apex.
- Add `WELDMAIL_DOMAIN` + `MAIL_INBOUND_WORKER_NAME` to `[vars]`,
  `[env.test.vars]`, `[env.production.vars]` in workspace-worker and mail-api
  `wrangler.toml` (mail-api's `MAIL_INBOUND_WORKER_NAME` matters on its own:
  test custom-domain provisioning also points catch-alls at production today),
  and to their `Env` types.

### 3. Stop swallowing provisioning failures

- One idempotent routine, `ensureWorkspaceMail`
  (`workspace-worker/src/services/workspace-mail.ts`), behind the provisioning
  workflow and the backfill route: domain row first as `pending`, then
  Cloudflare, then `verified`, then the `team@` mailbox. Cloudflare runs on
  every call, also when `team@` exists, so a re-run repairs a domain that was
  never routed. When Cloudflare refuses, the row stays `pending` and no
  mailbox is created.
- Hourly repair (`17 * * * *`, `services/mail-repair-sweep.ts`): workspaces
  created in the last 7 days whose domain is not among the apex zone's Email
  Sending subdomains (the last provisioning step) get `ensureWorkspaceMail`
  again, at most 5 per run. Kept off the `*/5` tick, which must not open a
  database while the pool is settled. Older gaps are the backfill route's job.

### 4. Free the slot when a workspace is deleted

`handleOrganizationDeleted` (every workspace deletion ends there) calls
`deprovisionMailDomain(env, slug)`, non-blocking. Cloudflare has no call that
removes one routing subdomain (`emailRouting.dns.delete` disables routing for
the whole zone), so it removes the Email Sending subdomain, unlocks the name's
routing records (`emailRouting.dns.edit({ name })`) and deletes the MX/SPF
records named exactly `{slug}.{apex}`. **Not yet verified against Cloudflare:**
check on weldmail.org that a deleted test workspace's slot is actually freed,
and that the workspace-worker token may delete DNS records.

### 5. Move existing test workspaces

1. List test master `workspaces` slugs; match against the 20 subdomains on
   `weldmail.com` to split test from production.
2. Run the workspace-worker backfill on test to provision the new apex and
   `team@{slug}.weldmail.org`.
3. Old `*.weldmail.com` addresses on test (mail_accounts, registry rows) are
   not rewritten: test data, they were never receiving. Mark them inactive.
4. Deprovision the test subdomains from the `weldmail.com` zone to free
   production's cap.

### 6. Consumer WeldMail on test (optional, same change or next)

Bare `@weldmail.com` personal addresses on test (personal-api,
`routes/mail-weldmail.ts:16`) have the same problem: they land on the
production worker. With the zone in place it is one constant:
`WELDMAIL_DOMAIN` in personal-api, plus the claim UIs reading the domain from
the API instead of defaulting to `'weldmail.com'`
(`apps/web/weldmail/src/pages/ClaimPage.tsx:11`,
`apps/mobile/weldmail-app/app/claim-address.tsx:42`).

## Out of scope

- The production zone's 30-domain cap. With test gone it's ~10–15 production
  workspaces, and step 4 stops leaks, but production will still hit it as it
  grows. Needs its own decision (more apex zones, or Enterprise subdomain zones).
- i18n: no new user-visible strings; display fallbacks of `'weldmail.com'`
  only show before the API answers.

## Checks

- Unit: `isSharedWeldMailDomain` / `weldMailDomainFor` for both apexes;
  `mail-provisioning` uses the env apex and worker name; provision step marks
  `pending` on Cloudflare failure; inbound `catch-all.test.ts`, outbound
  `ledger-core.test.ts` cover a `*.weldmail.org` sender.
- `wrangler-config.test.ts` passes with the new vars.
- On test after deploy: create a workspace, `dig MX {slug}.weldmail.org`,
  send from Gmail, mail appears in the WeldMail inbox; `wrangler email routing
  rules get weldmail.org catch-all` shows `weldsuite-mail-inbound-test`,
  and `weldmail.com`'s still shows `weldsuite-mail-inbound`.
- Docs: amend MAIL-007 (or a new MAIL ADR) with the per-environment apex.
