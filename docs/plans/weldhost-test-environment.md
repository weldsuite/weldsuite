# WeldHost on the test environment: Realtime Register OTE + emulated DNS

Status: phases 2 and 3 implemented (2026-10-22); phase 1 (OTE account and
test secrets) and phase 4 (end-to-end check on test) still to do.

## Goal

On `app-test.weldsuite.org`, a workspace can search for a domain, check it out
with a Stripe test card, and get it **registered at Realtime Register's OTE**
(their test registrar, `api.yoursrs-ote.com`). After that the domain behaves
like a real WeldHost domain: it has a DNS zone and editable records, and the
helpcenter, WeldMail and WeldReach screens that write records work.

The constraint: test **must not create zones or records in a real Cloudflare
DNS account**. An OTE domain doesn't exist in the real registry, so Cloudflare
would refuse the zone anyway (error 1049, "not a registered domain"). And a
domain that does exist in the real world must not get a zone in our account
just because someone tested with it.

## How it works today

| Step | Where | External call |
|---|---|---|
| Search | `searchDomains` in `packages/domains/host/src/domains.ts` → `RealtimeRegistrar.searchDomains` | **ADAC** (`adac.api.yoursrs.com`, hard-coded, production only) |
| Availability before checkout | `createCheckout` → `rtr.checkDomains` | ADAC `check`, or the REST check when there is no ADAC key |
| Pay | `POST /api/domains/checkout` (host-api) | Stripe Checkout |
| Register | billing-worker `handleDomainRegistrationCheckout` → `registerClaimedDomain` | **1. `createCloudflareZone`**, 2. `rtr.register({ nameservers: <CF NS> })` |
| Async finish | host-api `/public/webhooks/realtime-register` + process polling | RTR REST |
| DNS records | host-api `services/dns-records.ts`, `lib/host-dns-sync.ts`; desk-api helpcenter settings | Cloudflare zones + records (source of truth, HOST-003) |
| External domain connect | `verifyOwnershipAndCreateZone` | TXT lookup, then `createCloudflareZone` |

The OTE switch already exists: `REALTIME_REGISTER_OTE=true` makes both
`getRealtimeRegistrar` (host-api) and billing-worker use
`https://api.yoursrs-ote.com/v2/`. Three things still break on test:

1. **Search and the availability check use ADAC, which only knows the real
   registries.** OTE registries are separate. ADAC can say "available" for a
   name that is already registered in OTE (and the reverse), and its prices are
   production prices.
2. **Registration creates the Cloudflare zone first.** A failure there fails
   the whole registration (`markRegistrationFailed`), so no OTE domain can be
   registered.
3. **Every DNS screen calls Cloudflare.**

## Plan

### Phase 1: OTE account and configuration (no code)

1. Create the OTE account in the OTE portal (`dm.yoursrs-ote.com`). OTE keys,
   customer handles and contacts are separate from production.
2. In OTE, create the three platform contact handles (admin/tech/billing,
   HOST-002) and note the handles.
3. Set the notification webhook in the OTE portal to
   `https://host-api-test.weldsuite.org/public/webhooks/realtime-register?token=<REALTIME_REGISTER_WEBHOOK_SECRET>`.
4. Put the OTE values in the **test** environment for `host-api` and
   `billing-worker` (Doppler → `scripts/secrets/manifest.ts` sync):
   `REALTIME_REGISTER_API_KEY`, `REALTIME_REGISTER_CUSTOMER`,
   `REALTIME_REGISTER_OTE=true`, `REALTIME_REGISTER_CONTACT_*`,
   `REALTIME_REGISTER_WEBHOOK_SECRET`. Production is not touched.
5. Confirm billing-worker-test and host-api-test use **Stripe test-mode** keys,
   so checkout runs with `4242 4242 4242 4242`.
6. Check that test's master DB `domain_pricing` has rows for the TLDs we'll
   test with (`.com`, `.net`, `.org`, `.eu`, `.io`). Don't run the pricelist
   sync against OTE: OTE prices aren't meaningful.
7. Smoke test with curl: `GET /v2/domains/<name>/check` and a
   `domain-register-quote` against OTE. This shows which TLDs OTE actually
   simulates (open question 1).

### Phase 2: Search and availability from OTE

Under OTE, availability has to come from the registrar we will register with.

- `RealtimeRegistrar` keeps its `ote` flag (it's currently only used for the
  base URL).
- `checkDomains`: when `ote` is set, always use `checkDomainsViaRest` (OTE
  REST), even if an ADAC key is configured.
- `searchDomains`: when `ote` is set, skip ADAC. Fan out
  `checkDomainsViaRest` over `<sld>.<tld>` for a TLD list passed in by the
  caller. `searchDomains` in `@weldsuite/host-domain` already loads the pricing
  map, so it passes the priced TLDs, capped at about 10. The client already
  limits fan-out to 5 at a time.
- On test, leave `REALTIME_REGISTER_ADAC_*` unset in addition to the above, so
  nothing calls the production ADAC.
- Tests: extend `packages/core/realtime-registrar` tests and
  `domains-registrar.test.ts` with an `ote: true` case that asserts no
  `adac.api.yoursrs.com` request is made.

Result: search, checkout and registration all see the same OTE registry, so a
domain that shows as available can actually be registered.

### Phase 3: Emulated DNS (Cloudflare zones emulator)

**Approach:** emulate the part of the Cloudflare API that `@weldsuite/cloudflare-zones`
uses, behind the SDK's transport (`fetch`). Callers don't change: the
billing-worker webhook, `dns-records.ts`, `host-dns-sync.ts`, the helpcenter
settings and `verifyOwnershipAndCreateZone` keep calling `createCloudflareZone`,
`createDnsRecordInZone` and so on. HOST-003 (zone is the source of truth, local
table is a mirror) still holds; on test the "Cloudflare" is the emulator.

The seam already exists: `client()` in `packages/core/cloudflare-zones/src/index.ts`
takes an injected `fetch` (`__setZonesFetchForTests`). We make it a supported
configuration instead of a test-only hook.

#### 3a. The emulator

- New module `packages/core/cloudflare-zones/src/sandbox/`:
  `createSandboxZonesFetch(db: D1Database, opts)` returns a `ZonesFetch` that
  answers these endpoints in Cloudflare's v4 envelope
  (`{ success, errors, messages, result, result_info }`):
  - `POST /zones`, `GET /zones?name=`, `GET /zones/:id`, `DELETE /zones/:id`
  - `GET|POST /zones/:id/dns_records`, `PUT|PATCH|DELETE /zones/:id/dns_records/:rid`
    (all record types the package sends, including CAA/SRV `data` objects)
  - `POST /zones` for a name that's already there → error `1061`. A name that
    isn't a valid registrable domain → `1049`. These keep the existing
    `toZoneError` mapping working.
- Storage: a **test-only D1 database** `weldhost-dns-sandbox-test`
  (created 2026-10-22, id `93f483fb-0cf3-44ce-ae66-b6661aea5375`) with tables
  `sandbox_zones` and `sandbox_dns_records`. The store creates them on first
  use, so there are no migrations to run or wire into CI. D1 rather than KV
  because the sync reads a zone right after writing it, and KV is eventually
  consistent. D1 rather than Neon because it keeps sandbox tables out of the
  master schema.
- Zone IDs are `sbx` + 29 hex chars. Real Cloudflare IDs are 32 hex chars, so
  nothing can confuse the two. Nameservers come from
  `DNS_SANDBOX_NAMESERVERS` (see 3c).
- Zone status: `pending` on create, then `active` on the first `GET` at least
  60 s later. That exercises `refreshZoneStatus` the way a real delegation
  would.

#### 3b. Overlay, not a full replacement

Some workers call the same package for **platform-owned real zones**:
`workspace-worker` looks up the WeldMail apex zone (`MAIL_APEX_ZONE`), and
`worker-email` resolves zones for Email Service. Those calls must keep reaching
real Cloudflare. So the sandbox fetch is an overlay:

- `POST /zones` → always the sandbox. On test, only WeldHost creates customer
  zones.
- Anything addressed by zone ID → the sandbox if the ID starts with `sbx`,
  otherwise passed through to the real `fetch`.
- `GET /zones?name=` → the sandbox first, then real Cloudflare.

Result: test never creates anything in real Cloudflare, but reading the
platform's own zones still works.

#### 3c. Turning it on

- `configureZonesSandbox(env)` in `@weldsuite/cloudflare-zones` sets the
  module-level transport when **all** of these hold: `ENVIRONMENT !== 'production'`,
  `WELDHOST_DNS_MODE === 'sandbox'`, and the `DNS_SANDBOX` D1 binding is
  present. If `ENVIRONMENT === 'production'` and the mode is set, it throws,
  so a misconfiguration fails loudly.
- Call it at the top of `fetch` / `scheduled` / `queue` in the workers that
  touch customer zones: **host-api, billing-worker, desk-api**. Add the
  `DNS_SANDBOX` D1 binding and the `WELDHOST_DNS_MODE = "sandbox"` var to
  their `[env.test]` blocks only (plus the `-dev` top level for local work).
  Production config stays unchanged; extend
  `packages/core/api-modules/src/wrangler-config.test.ts` to fail if
  `[env.production]` ever gets either one.
- `DNS_SANDBOX_NAMESERVERS`: the NS pair handed to `rtr.register`. Most OTE
  registries don't check delegation, but some do (`.de`, `.nl` and other
  ccTLDs with predelegation checks). Use nameservers OTE accepts (open
  question 2). If a registry still rejects them, the fallback in
  billing-worker is to register **without** `ns` in sandbox mode, which RTR
  allows for most TLDs.

#### 3d. Being honest in the UI

- The domain detail page shows a small "Test environment: DNS is simulated,
  nothing resolves publicly" badge when the zone ID starts with `sbx`
  (en + nl strings).
- WeldMail custom-domain sending and WeldReach mailboxes on a sandbox domain
  can write their records, but mail won't deliver. That's expected and stated
  in the badge.

### Phase 4: Verify end to end on test

1. Search `weldsuite-ote-<random>` → `.com` available (OTE REST check).
2. Check out with a Stripe test card → webhook → sandbox zone created →
   `rtr.register` at OTE → row `active` (or `pending_workflow`, then finished
   by the OTE webhook or the poller).
3. Add, edit and delete A/MX/TXT/CAA/SRV records. The mirror table matches the
   emulator after every sync.
4. Refresh zone status → `active` after 60 s.
5. Helpcenter custom domain on the sandbox domain → CNAME written into the
   emulator.
6. Auth code, lock, privacy toggles against OTE.
7. Auto-renew cron (`0 4 * * *`) against OTE for a domain with `expiresAt`
   backdated in the test DB.
8. Check real Cloudflare: no new zones in the account
   (`zones.list({ name })` for the test names returns nothing).

Add a Playwright spec under `e2e/specs/weldhost/` for steps 1–3, running
against test only.

## Rejected alternatives

- **A separate real Cloudflare account for test.** You asked for no real DNS,
  and Cloudflare rejects zones for names that don't exist in the real registry,
  which is every OTE registration.
- **Skip DNS on test entirely** (register at OTE without nameservers, and no
  zone row). It's the smallest change, but DNS editing, helpcenter domains,
  WeldMail and WeldReach could then never be tested on a WeldHost domain. It's
  a fine interim step if phase 3 has to wait: in billing-worker, skip
  `ensureCloudflareZone` when `REALTIME_REGISTER_OTE=true`.
- **Branch on "sandbox" in each caller** (dns-records, host-dns-sync,
  helpcenter, billing-worker). That spreads test-only branches across four
  workers. The transport overlay keeps them all in one package.
- **Use Realtime Register's own DNS hosting on OTE.** That would be a second
  DNS provider code path that only test uses, and it contradicts HOST-003.

## Open questions

1. Which TLDs OTE actually simulates for check/register (smoke test in phase 1,
   step 7). The test TLD list and the pricing rows follow from that.
2. Which nameservers OTE accepts for `ns` on register. Ask RTR support, or test
   with the curl from phase 1.
3. Whether ADAC has an OTE endpoint. Phase 2 doesn't depend on it; if one
   exists, it could replace the REST fan-out on test.

## Docs

This is an architectural decision (test environment uses a Cloudflare emulator
behind `@weldsuite/cloudflare-zones`). Add ADR **HOST-007** in
`weldsuite-documentation` and a "Test environment" section in
`design/modules/weldhost.md`, linked from the implementation PR.

## Files touched (estimate)

- `packages/core/realtime-registrar/src/index.ts` (+ tests): OTE search/check
- `packages/domains/host/src/domains.ts`: pass priced TLDs to search
- `packages/core/cloudflare-zones/src/sandbox/*` (new: `fetch.ts` emulator,
  `store.ts` D1/memory store, `index.ts` `configureZonesSandbox`) +
  `src/transport.ts`; tests in `apps/workers/host-api/src/lib/dns-sandbox.test.ts`
- `apps/workers/{host-api,billing-worker,desk-api}/src/index.ts` +
  `wrangler.toml` (`[env.test]` only)
- `apps/workers/billing-worker/src/routes/webhooks.ts`: register-without-NS
  fallback in sandbox mode
- `packages/core/api-modules/src/wrangler-config.test.ts`: production guard
- Platform domain detail badge + `packages/core/i18n` en/nl
- `scripts/secrets/manifest.ts`: comments for the OTE values
