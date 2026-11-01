# weldsuite-mail

WeldMail's API as `apps/workers/mail-api` serves it, on the Kubernetes
editions (module id `mail`, ADR API-014 and MAIL-010). Shared mail logic
(mailbox access, the Postgres mailbox store, the outbound guard and the
transport) lives in `rust/crates/mail-domain`, which Calendar, Desk and CRM
send through too.

One Rust module per mail-api route group (`src/routes/<group>.rs`), each with
a `routes()` function at its paths relative to `/api`; `src/lib.rs` assembles
them. Groups outside `/api` (`/internal/*`) have their own router.

| Route group (mail-api) | Rust module | Status |
|---|---|---|
| `/api/mail-sending` | `routes::mail_sending` | ported |
| `/internal/outbound` | `routes::internal_outbound` | ported |
| `/api/mail-accounts` (CRUD, access, sync, send) | `routes::mail_accounts` | ported |
| `/api/mail-messages` (reads, updates, bulk, labels, reply) | `routes::mail_messages` (+ `_reads`, `_writes`) | ported, except `POST /:id/forward` |
| `/api/mail-labels`, `/api/mail-folders`, `/api/mail-signatures` | `routes::mail_labels`, `mail_folders`, `mail_signatures` | ported |
| `/api/mail-drafts`, `/api/mail-attachments` | `routes::mail_drafts`, `mail_attachments` | ported |
| `/api/mail-threads`, `/api/mail-snooze`, `/api/mail-sync` | `routes::mail_threads`, `mail_snooze`, `mail_sync` | ported |
| `/api/mail-templates`, `/api/mail-rules`, `/api/mail-campaigns` | `routes::mail_templates`, `mail_rules`, `mail_campaigns` | ported |
| `/api/mail-scheduled` | | not started (needs the SendScheduledEmail job) |
| `/api/mail-subscriptions` | | not started |
| `/api/mailboxes` | | not started (cross-workspace, org-less) |
| `/api/mail-domains`, `/api/mail-weldmail`, `/api/mail-ai`, `/internal/mail-store` | | not ported; proposed exclusions (MAIL-010, the AI port, the object store) |
| `mail-sending-events`, `mail-outbound-review` consumers | `consumers` | handlers ported |
| inbound (mail-inbound-worker) | | not started |

The routes run the `postgres` mailbox store only (MAIL-010); the shared
message, thread and label logic is in `weldsuite_mail_domain::{messages,
threads, labels, access}`. Conformance suites: `mail: *` in
`rust/conformance/suites.json`.

The module is not marked ported (`RUST_PORTED_MODULES`) until every group is.
