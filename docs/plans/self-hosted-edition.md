# Self-hosted edition (Self-hosted 1.0)

Status: **Decided, implementation starting, 2026-11-09.** Nothing below is
built yet beyond what "Where we are" lists. This plan implements P7 of the phase plan
(`design/platform/editions-and-self-hosting-phases.md` in
`weldsuite/weldsuite-documentation`) under ADR OPS-014 (self-hosted
distribution, Proposed), on the Rust backend (API-014) and the one image and
chart of OPS-013. Progress is recorded in that repo's
`design/platform/editions-and-self-hosting-status.md`.

## Goal

A customer installs WeldSuite on their own servers from public images, a
script and the docs, without help from us. They can license it, upgrade it,
back it up and move a workspace in or out. WeldSuite's own servers become
install #0 later, on the same distribution.

**1.0 is done when** (P7's exit criteria, plus what this plan adds):

1. A fresh single-node install, following the docs, takes under 30 minutes and
   ends with `weldsuite doctor` all green and a first workspace signed up.
2. An upgrade from the previous release passes in CI and at a design partner,
   with a backup taken first and the skip-two-minors guard in place.
3. A workspace exported from one install imports into another, files and
   members included.
4. An install with no licence file runs as the community edition; a commercial
   licence file applies offline and its state shows in the app.
5. Images and chart are multi-arch, signed and have an SBOM.
6. Nothing in a self-hosted install points at a `weldsuite.org` host or a
   WeldSuite-run service unless the operator configured it.

## What a customer installs

- **One hostname** (`weldsuite.example.com`): `weldsuite serve` answers the API
  and serves the SPA with a generated `/config.json`. Optional second hostnames
  for the sign portal, the admin console and later the portals.
- **The `weldsuite` chart** from `oci://ghcr.io/weldsuite/releases`, with a
  profile (`single-node`, `small-ha`, `large`). Each dependency is either
  bundled by the chart or external: Postgres (CloudNativePG), Valkey, NATS
  JetStream, Restate, object storage, the OIDC provider (Zitadel), LiveKit,
  inbound mail (Haraka).
- **Prerequisites the script installs**, because they are cluster-wide
  operators a chart shouldn't own: k3s (single node only), cert-manager and the
  CloudNativePG operator.
- **The `weldsuite` binary's operator commands**, run with `kubectl exec`:
  `doctor`, `licence`, `backup`, `restore`, `workspace export|import`, and the
  staff commands under `admin`.
- **The modules that have a Rust implementation**: today every one but
  WeldAgent. AI features stay hidden, as on EU (AI-011).

## Where we are (2026-11-09)

| P7 # | Work package | State |
|---|---|---|
| 7.1 | Licence files | Not started. A per-workspace licence model exists for partners (`workspace_licences`: `allowed_apps`, `max_seats`, `status`), and the gate already follows it |
| 7.2 | Web apps from the image | SPA in the server image with `/config.json` from `PUBLIC_ENV`; sign portal, admin console and collab-rooms are their own images in the chart. Help center, booking and meeting portals and the widget app have no image |
| 7.3 | `doctor`, `backup`/`restore`, `workspace export`/`import` | Not started. `weldsuite admin` has `access` and `staff` only. Infrastructure backups (CloudNativePG with barman) are in the EU runbook |
| 7.4 | Bring-your-own adapters | Sign-in only: `AUTH_PROVIDER=oidc` verifies any issuer whose org claim fits. Every identity write (signup, workspace creation, invites, membership, sync) goes through the `Identity` port, whose one adapter is Zitadel. `SMTP_URL` takes any relay for system mail (customer mail needs `MAIL_SMTP_URL` too); Postgres and S3 are external by config |
| 7.5 | Install profiles, k3s script | Not started. The chart bundles no dependency (the EU cluster gets them from Flux layers in `rust/deploy/flux/infrastructure`) and lacks five CronJobs the binary has (`mail-outbound-ledgers`, `calendar-replan`, `flow-file-purge`, `flow-approval-due`, `flow-benefit-measure`) |
| 7.6 | Signing, SBOM, EU registry | Not started. Five images on ghcr.io, amd64 only; arm64 is cross-built in CI but never pushed |
| 7.7 | Release process | `rust-release.yml` exists but has never run. The binary reports `0.0.0` whatever the release. No channels, no upgrade tests, no skip guard |
| 7.8 | Self-hosting docs | Not started. No operator guide anywhere; the EU runbook is the closest |
| 7.9–7.11 | Commercial, design partners, install #0 | Not started |

**Defaults that still assume Global.** `AUTH_PROVIDER` defaults to `clerk`
(binary and chart), `VIDEO_PROVIDER` to `realtimekit` (Cloudflare, Global
only), and `ENVIRONMENT=production` picks `*.weldsuite.org` defaults for
every URL nobody set. The public URL is read under four names
(`PUBLIC_APP_URL`, `APP_URL`, `PLATFORM_URL`, the calendar's `app_url`), and
some links have no override at all: WeldSign's "open in app" link,
`S3_PUBLIC_URL`'s fallback to a test bucket host, CORS's compile-time
first-party origins, MCP's help link. About 51 files read the environment
directly, outside `Config`, so startup can't check them.

**Reused as they are:** the platform's auth facade with an OIDC implementation
and runtime config (`apps/web/platform/lib/auth`, `lib/runtime-config.ts`),
workspace slugs in the platform's URLs (FE-013), edition flags in
`/config.json` (`rust/bins/weldsuite/src/edition.rs`), the server's degraded
start when a service isn't configured (`rust/bins/weldsuite/src/infra.rs`), the
migration Job, `rust/deploy/kind/smoke-test.sh` and its services, the EU Flux
layers as the reference for every dependency's chart and values, the
`weldsuite admin` parser, actor and audit pattern
(`rust/bins/weldsuite/src/admin.rs`, `rust/crates/staff-domain`), the
migrations crate's journal and tenant listing (`rust/crates/migrations`), the
master `system_settings` key-value table, and the DATA-016 move workflow's
table-by-table copy (`apps/workers/workspace-worker/src/services/database-move/`)
as the model for backup and export.

## Decisions (taken 2026-11-09)

All eight were taken on 2026-11-09 as this plan recommended; the
alternatives stay here for the ADRs. The ones marked **(ADR)** get an ADR
(Proposed) in `weldsuite-documentation` with their track's first PR, Accepted
when the track lands.

1. **What the community edition gets (ADR, amends OPS-014).**
   - *Decided:* no caps. Without a licence file the install runs every
     ported module for any number of users, labelled "Community". A licence
     file adds support tier, the `lts` channel's entitlement and the contract's
     seats and modules, which the gate shows and enforces for that install.
     Removing the licence returns the install to the community edition under
     the AGPL. This is OPS-014's "commercial control, not DRM" taken at its
     word.
   - *Alternative:* a community cap (for example 25 active users) the licence
     lifts. A revenue lever, patchable under the AGPL, and a reason for small
     teams not to try it.
2. **Bundled dependencies (ADR, amends OPS-013/014).**
   - *Decided:* toggles in the one `weldsuite` chart, as the design doc
     says: Valkey, NATS, Restate, Zitadel, object storage and LiveKit as
     subchart dependencies with a `condition`, Postgres as a CloudNativePG
     `Cluster` and `Pooler` the chart renders when `postgres.bundled`.
     Operators (cert-manager, CloudNativePG) are prerequisites, installed by
     the script or by the cluster owner. Subchart versions are the ones the EU
     Flux layers pin, checked by a CI drift test.
   - *Alternative:* the install script installs Flux and applies the EU base
     layers with self-hosted values. One tested path, but every customer has
     to learn Flux to troubleshoot, and OPS-014 says Helm only.
3. **Registry and signing for 1.0 (amends OPS-014).**
   - *Decided:* ship on ghcr.io (public, free, already built), signed with
     cosign keyless from GitHub Actions, SBOM and provenance attached. Mirror
     to the EU registry when P5 5.4 builds it; the signatures travel with the
     images.
   - *Alternative:* wait for the EU registry. Blocks 1.0 on EU infrastructure
     that is dormant until the first EU customer.
4. **Identity in 1.0 (ADR, amends SEC-012).**
   - *Decided:* bundled Zitadel is the default and the tested path (the
     same adapter and sync as EU). Bring-your-own OIDC ships in 1.0 in
     **membership mode**: the provider only authenticates; workspaces,
     members and invites live in WeldSuite's databases, and the active
     workspace comes from the request (the platform already names it in the
     URL, FE-013), checked against WeldSuite's membership. That is what
     SEC-012 means by "the provider only has to authenticate", without
     needing groups in the customer's directory. A group claim becomes an
     optional auto-join, not the mapping.
   - *Alternative:* SEC-012 as written: map a workspace to a group claim. It
     needs a group per workspace in the customer's directory and can't say
     which of several workspaces a request is for.
5. **Web surfaces in 1.0.**
   - *Decided:* the helpdesk widget app and the meeting portal (guests
     can't join a meeting without it) in 1.0; the help center and booking
     portal when a design partner needs them, shared with P6's EU work. The
     mobile apps' server address at sign-in (4.F4) and the push relay in 1.1.
   - *Alternative:* all portals and mobile in 1.0, which roughly doubles the
     web track.
6. **Backup and export format (ADR, DATA).**
   - *Decided:* our own logical format, the DATA-016 move's approach: per
     database, table by table, rows as text through `COPY`, with a manifest
     (schema migration tag, row counts, checksums, edition, version). No
     `pg_dump` binary in the distroless image, no Postgres major-version
     coupling, and the same code serves `backup`, `workspace export` and
     edition moves. Disaster recovery for bundled Postgres is CloudNativePG's
     barman-cloud backups to the customer's S3, configured by the profiles.
   - *Alternative:* `pg_dump`/`pg_restore` in a tools image. Proven, but
     version-coupled and not usable for moving a workspace between editions.
7. **personal-api.** *Decided:* off on self-hosted (no
   `DATABASE_URL_PERSONAL`); consumer WeldMail and WeldCalendar stay Global.
   Its authorized parties and web hosts are hard-coded to Global's anyway.
8. **Versions and channels.** *Decided:* the `X.Y.Z` releases
   `rust-release.yml` already cuts. `stable` is a chosen release each month,
   `lts` one each year with 12 months of fixes on a `release/X.Y` branch,
   published as a `channels.json` with the GitHub release. The skip guard
   compares the chart's version with the install's recorded one.

## Work packages

Each item is about one PR. Sizes: S (a day or two), M (up to a week), L (more).
Every Rust change keeps the conformance and parity rules of `rust/README.md`.

### A. Versions and releases (7.7)

| # | What | Size |
|---|---|---|
| A1 | **Real versions.** A release copies a tested `main` build digest for digest (`rust-release.yml`), so the binary can't be stamped with its release version at build time. Instead the build stamps the commit (`weldsuite version`, `/health`), and the chart passes `.Chart.AppVersion` (set to `X.Y.Z` by the release) as `WELDSUITE_RELEASE`, which `/health`, `/config.json` (today `CARGO_PKG_VERSION`, `server.rs`) and the skip guard (A3) read | S |
| A2 | **Cut the first release** with `rust-release.yml` and make the `releases` chart package public (the runbook step in `rust/deploy/hetzner/README.md`, "Releases"). Fix the image counts in `rust/README.md` and the workflow comment (five images, not three or four). Needed by every upgrade test | S |
| A3 | **Install state in `system_settings`** (master, key-value, already used by identity sync): `install.id`, `install.release` and `install.release_history`, written by `weldsuite migrate` after a successful run. `migrate` refuses a release more than two minor versions ahead of the recorded one unless `--allow-skip`. No migration needed | S |
| A4 | **Pre-upgrade order**: a Helm `pre-upgrade` hook runs `weldsuite backup` (C2, on by default, `upgrade.backup.enabled`) before the migration Job | S |
| A5 | **Channels**: `channels.json` (`stable`, `lts`, with versions and end-of-fix dates) published with each GitHub release; release notes from merged PRs touching `rust/` and the chart | S |
| A6 | **Upgrade tests in CI**: on kind, install N-1 (and N-2 once it exists) from the releases registry, seed data, upgrade to the PR's chart, run `doctor` and the smoke suite. On PRs touching the chart or migrations, and nightly | M |

### B. Licence (7.1)

| # | What | Size |
|---|---|---|
| B1 | **ADR (OPS-019): licence file and gate.** Token `wsl1.<base64url(json)>.<base64url(ed25519 sig)>`; fields: licence id, key id, customer, edition, seats, modules (`*` or a list), support tier, `lts` entitlement, issued, not-before, expires. Public keys compiled into the binary as a keyring by key id, so a key can be rotated. States: none (community), valid, grace (≤ 30 days past expiry), expired (read-only), invalid (refused) | S |
| B2 | **`crates/licence`**: parse, verify, state at a given time, with test vectors (valid, tampered, wrong key id, expired, grace edge) | S |
| B3 | **`weldsuite licence show|apply|remove`**, in the `admin` pattern (actor, `--reason`, an `admin_audit_events` row), stored as `install.licence` in `system_settings`; or `WELDSUITE_LICENCE` from a Secret for GitOps installs (the Secret wins). `serve` refuses to start on an invalid token rather than silently running as community | S |
| B4 | **Gate integration.** The install licence is an install-wide ceiling above the per-workspace partner licence, which stays as it is. Add it as an input to `compute_workspace_restrictions` (`rust/crates/db/src/restrictions.rs`, called from `Workspaces::resolve`), so the `/api` gate (`rust/crates/pipeline/src/licence.rs`) and the `/v1` and `/mcp` gate (`rust/modules/external-api/src/gates.rs`) both follow it: expired past grace means read-only, unlicensed modules mean `APP_NOT_LICENSED`. Narrow `/config.json`'s `modules` the same way. Seats: an install-wide count of active members, checked in `check_seats` (`rust/modules/core-team/src/groups/team_members/manage.rs`) next to `workspace_seat_limit`; over the cap new invites are refused, nothing becomes read-only. `/config.json` carries the licence state for a banner (community, days left, grace, expired) | M |
| B5 | **Signing tool** `rust/bins/weldsuite-licensor` (not in the image): `issue` and `inspect`, signing through PKCS#11 on a hardware token that supports Ed25519, a file key for tests only. Where issued licences are recorded is decided with 7.9 | M |
| B6 | **Licence page in the admin console** (show and apply) and the in-app banner, en and nl | S |

### C. Operator commands (7.3)

| # | What | Size |
|---|---|---|
| C1 | **`weldsuite doctor`**, built on the full `Config` as `cron` is (not the master-only environment `admin` reads), reusing `Config::from_lookup`'s problem list, `infra::connect`, `Workspaces::ping_master` and `migrations::pending`. One line per check with pass, warn or fail and the fix: config; master DB reachable and migrated to this release; a sample tenant DB connects; Valkey, NATS streams, Restate admin; S3 put, range get, etag, create-only and delete on a probe key; OIDC discovery and JWKS; both SMTP relays (`SMTP_URL` for system mail, `MAIL_SMTP_URL` for customer mail): connect, STARTTLS and auth, a test mail only with `--send-test`; the public hostname resolves to the ingress and its certificate is valid for more than 14 days; MX and port 25 when inbound mail is on; clock skew; the licence state; and a warning for every setting still on a Global default (D6). Also a Helm test hook, so `helm test` runs it | M |
| C2 | **`weldsuite backup` and `restore`**: master, every tenant DB (the migrations crate's tenant listing) and the personal DB if there is one, in the format of decision 6, to an S3 prefix or a volume, with a manifest; restore into an empty install of the same release. Pre-upgrade hook (A4). Files are the object store's own job (versioning or replication), documented | L |
| C3 | **`weldsuite workspace export|import`**: one workspace (found by id, slug or org id with `access::find_workspace`) with its tenant tables, its master rows (workspace, members, roles, settings, app installs; placement left out) and its files under `workspaces/<id>/`, read in one repeatable-read snapshot with the DATA-016 soft lock while it runs. Import provisions the database, migrates it to the manifest's tag, loads it, and re-invites the members by email, since identities differ per install. Self-hosted and EU to self-hosted in 1.0; out of Global needs the same export from Neon and R2, after 1.0 | L |
| C4 | **The rest of SEC-014's commands**: `flags`, `apps` and `workspaces` (a self-hosted operator may not run the console). `plans` only if plan rows still limit anything once the licence carries seats and modules: a fresh install seeds no plans, so seats are unlimited per workspace today | M |

### D. Packaging and install (7.2, 7.5)

| # | What | Size |
|---|---|---|
| D1 | **Bundled dependencies in the chart** (decision 2): `postgres`, `valkey`, `nats`, `restate`, `zitadel`, `objectStorage`, `livekit`, each `bundled: true|false` with the external settings beside it; the server's environment, `TENANT_SHARDS` included (a role with CREATEDB and CREATEROLE), is derived from whichever is chosen. Zitadel's first-run setup (the first admin, the WeldSuite project, the web and staff apps, roles, the service token), done by hand on EU (`rust/deploy/hetzner/README.md`, step 7), becomes a chart Job. Start from the kind test's `services.yaml`. A CI test fails when a subchart's version differs from the EU Flux pin | L |
| D2 | **Generated secrets**: the chart creates the install's keys once (`DATABASE_ENCRYPTION_KEY`, `WELDPASS_ROOT_KEY`, `INTERNAL_API_SECRET`, `SIGN_SESSION_SECRET`, `STORAGE_SIGNING_KEY`, the admin console's session secret) and keeps them across upgrades (`lookup`), next to today's `existingSecret` and `secret.values`. `doctor` and the install script tell the operator to store `WELDPASS_ROOT_KEY` offline: losing it loses every stored secret | S |
| D3 | **Profiles**: `values-single-node.yaml`, `values-small-ha.yaml`, `values-large.yaml` (replicas, resources, PDBs, CloudNativePG instances and storage, barman-cloud) per the design doc's sizing table | S |
| D4 | **Install script** for one machine (`rust/deploy/install/install.sh`, published at a stable URL): checks OS, CPU, RAM, disk and ports; installs pinned k3s, cert-manager and the CloudNativePG operator; asks for the hostname, the ACME email, the SMTP relay and the first admin's email; installs the chart with the single-node profile; adds the first superadmin (`weldsuite admin staff add`) and the Zitadel admin; runs `doctor`; prints the URLs. Re-running it upgrades | M |
| D5 | **CI job `Rust · self-host install`**: the chart with every dependency bundled on a fresh kind or k3d cluster, then `doctor` and a smoke run: sign up through Zitadel (the kind test skips signup today), create a workspace, a CRM record and a file, receive a system mail in Mailpit. Required on PRs touching `rust/deploy/`; a full run of the script with k3s on a VM nightly, timed against the 30-minute goal | M |
| D6 | **Self-hosted defaults.** With `EDITION=self-hosted`: `AUTH_PROVIDER` defaults to `oidc` (binary and chart) and video to LiveKit when configured, otherwise off, never RealtimeKit. One public URL setting (`PUBLIC_URL`, a chart value) that every module reads instead of `PUBLIC_APP_URL`, `APP_URL`, `PLATFORM_URL` and the calendar's `app_url`, with the others derived from it when unset (`PUBLIC_API_URL`, `APP_API_PUBLIC_URL`, the webhook and connector base URLs, `S3_PUBLIC_URL`, the portal URLs). Overrides for what has none today: WeldSign's app link, the storage fallback, extra CORS origins for separately hosted portals, MCP's help link, the Message-ID and ICS domains. The chart exposes these values and adds the five missing CronJobs. The environment reads that matter for an install move into `Config`, so startup and `doctor` check them | L |
| D7 | **Portals** (decision 5): the helpdesk widget app served by `serve`, the meeting portal for guests; later the help center (TanStack Start, a Node build like the sign portal, FE-017) and the booking portal. Shared with P6 | L |

### E. Bring-your-own identity (7.4)

| # | What | Size |
|---|---|---|
| E1 | **A second `Identity` adapter for membership mode** (decision 4) next to `ZitadelIdentity` (`rust/crates/ports/src/identity.rs`, `rust/crates/adapters-oss/src/zitadel.rs`): onboarding creates the workspace in WeldSuite only, invites bind on the first sign-in with that verified email, membership and roles stay in WeldSuite's databases, the membership cap and `identity-sync` do nothing. The org claim (`rust/crates/auth/src/oidc.rs`, `organization()`) gives way to the workspace the request names, checked against membership in the workspace middleware. If it needs a master table, ask before the migration | L |
| E2 | **Provider-neutral scopes**: the SPA's OIDC client asks for Zitadel's scopes by default (`apps/web/platform/lib/auth/oidc/session.ts`) and `runtime-config.ts` accepts overrides, but the server never sends them; `/config.json`'s `auth` block carries scopes, audience scope and organization scope per provider | S |
| E3 | **Keycloak in CI**: a Keycloak testcontainer with an imported realm, signing in through the facade and the backend in membership mode; written guides for Entra ID and Authentik, checked by hand once per release | M |

### F. Supply chain (7.6)

| # | What | Size |
|---|---|---|
| F1 | **Multi-arch**: push the arm64 build CI already makes (`ci.yml`, cache only today) and publish amd64 and arm64 manifests for all five images, the Node ones (sign portal, admin, collab-rooms) and Haraka included | M |
| F2 | **cosign keyless** signatures on every image and the chart in `rust-images.yml` and `rust-release.yml`; the verify command in the docs | S |
| F3 | **SBOM and provenance**: syft SPDX attached as an attestation, GitHub build provenance | S |
| F4 | **EU registry mirror** when P5 5.4 exists (decision 3) | S |

### G. Docs (7.8)

A "Self-hosting" section on help.weldsuite.org
(`apps/web/docs/src/app/self-hosting/`, next to the module guides):
requirements and sizing, install on one machine, install on an existing
cluster, configuration reference, identity providers, mail (the two relays,
inbound), upgrades and channels, backup and restore, moving a workspace, the
licence, troubleshooting with `doctor`'s output, third-party services and the
keys each needs, and what isn't available (from `unavailableFeatures`). The
configuration reference is generated from `values.yaml` and `Config`, so it
can't drift. Written alongside the tracks, finished before the beta.

### H. Launch (7.9–7.11, mostly not code)

Licence agreement (lawyer), price list, support channel and SLA, partner terms
for partner-run installs (BILL-008); two or three design partners on the beta;
install #0 when the hardware is there (it can slip past 1.0).

## Order

```
Alpha (internal)   A1 A2 · D6 · D1 D2 D3 D4 D5 · C1
                   → a fresh VM to a working community install with the script, doctor green, in CI
Beta (partners)    A3 A4 A6 · B1–B6 · C2 C4 · E1 E2 E3 · F1 F2 F3 · G (draft)
                   → licensed installs that back up and upgrade safely, signed multi-arch images
1.0                C3 · A5 · D7 (widget, meeting portal) · G (final) · H
                   → the exit criteria above
```

D6 goes first: every later test would otherwise pass against Global
defaults. Within the alpha, D1 is the long pole and C1 grows with it (every
bundled dependency gets its check).

The tracks run in parallel, one session and branch each: D6 then D1–D5
(packaging), A1/A3–A6 with B (versions and licence), C (operator commands),
E (identity), F with A5/A6 (supply chain and release engineering). Chart
changes other tracks need (an env var, a hook) are small and merge after the
packaging track's. A2, cutting the first public release, waits for an
explicit go-ahead, since it publishes.

## Tests

- `Rust · self-host install` (D5) and the upgrade tests (A6), next to the
  existing `Rust · image and chart` kind smoke test.
- Licence test vectors (B2) and the gate's states in the pipeline tests,
  including a refusal, which the kind test never exercises today.
- A backup and restore round trip, and an export and import between two
  installs, with row counts and checksums compared (C2, C3).
- Keycloak sign-in in membership mode (E3).
- Conformance stays as it is: none of this changes a route both backends serve,
  except the licence gate, whose behaviour without an install licence must not
  move.

## Schema changes

None planned: the install's release and licence live in `system_settings`
(A3, B3). Membership mode (E1) may need a master table for pending invites by
email; if so, ask before generating the migration.

## Documentation to update

- ADRs: OPS-014 amended (community edition, registry) and Accepted at 1.0;
  SEC-012 amended (membership mode); new OPS-019 (licence file and gate), a
  DATA ADR for the backup and export format, and an amendment to OPS-013 for
  bundled dependencies in the chart.
- `design/platform/editions-and-self-hosting.md` ("Self-hosted") and the status
  page, as each track lands.
- `rust/README.md`: the new commands and chart values; its image list and
  arm64 claim, which are out of date.

## Risks

- **Support cost of unknown environments.** `doctor`, the profiles and the
  CI install test are the mitigation; design partners show what's missing.
- **Bundled Postgres on one node has no HA.** Backups and barman-cloud to an
  off-machine S3 are on by default in the single-node profile; the docs say
  so plainly.
- **Zitadel as a dependency we ship.** Its upgrades become part of ours; pin
  it and test its upgrade in A6.
- **Mail deliverability** is the customer's relay's job; inbound mail needs
  port 25 open, which many networks block. `doctor` checks it.
- **Two backends already, and now a third configuration surface.** Every
  chart toggle is a combination to test; keep the toggles to the list in D1.
- **Public endpoints the server calls without a setting**: Cloudflare's
  DNS-over-HTTPS resolver, the ECB's FX rates, the EU's VIES. Fine for 1.0,
  which isn't air-gapped; make them configurable before an air-gapped offer.
- **The licence can be patched out** (AGPL). Accepted by OPS-014: the
  contract is the control.

## Open questions

- Who besides WeldSuite may issue licences (partners, BILL-008), and where is
  the ledger of issued licences kept?
- The AI endpoint OPS-014 promises (the customer's own OpenAI-compatible
  endpoint) needs the Rust `ai` crate, which AI-011 deferred. In 1.1 at the
  earliest?
- An opt-in telemetry heartbeat (version, seat count): 1.0 or later?
- Third-party services the ported modules call (Telnyx, Cloudflare DNS,
  Mailpool, Ponto, Plaid, Meta and others): each is off with a clear error
  when its keys are unset. Which ones the docs present as supported with the
  customer's own keys?
