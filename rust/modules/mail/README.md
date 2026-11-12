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
| `/api/mail-domains` | `routes::mail_domains` | ported over the `MailDomains` adapter in `MailState::domains` (`RelayDomains` over the MTA's API with `MTA_API_URL`, else `ManualDomains`; none without `MAIL_MX_HOST`, and then `/config.json` lists `mail-domains` as unavailable). Not conformance-checked: Global provisions Cloudflare, so the answers differ by design (MAIL-010). A domain added here carries its workspace's ownership TXT record (`_weldmail-verify.<domain>`) and is verified only once that resolves too; a mailbox goes on a verified domain or an active WeldHost domain |
| `/api/mail-weldmail` | `routes::mail_weldmail` | ported on the deployment's own free-address domain, `WELDMAIL_DOMAIN` (`weldmail.eu` on the EU edition, MAIL-012); unset, or one of Global's (`weldmail.com`, `weldmail.org`), the routes answer 503 and `/config.json` lists `mail-free-addresses` as unavailable. Reserved mailboxes get their system labels |
| `/api/mail-ai`, `/internal/mail-store` | | not ported; proposed exclusions (the AI port, the object store) |
| `mail-sending-events` consumer | `consumers::SendingEventsSubscriber` | ported: the `mail-sending-events` subscriber of `consume`, on `MAIL_SENDING_EVENTS` (MAIL-011) |
| `mail-outbound-review` consumer | `consumers` | handler ported |
| inbound (mail-inbound-worker) | `crates/mail-inbound` (the `RCPT TO` check in `serve`, the `mail.inbound` subscriber in `consume`, Haraka in `deploy/haraka`) | ported (MAIL-010) |

The routes run the `postgres` mailbox store only (MAIL-010); the shared
message, thread and label logic is in `weldsuite_mail_domain::{messages,
threads, labels, access}`. Conformance suites: `mail: *` in
`rust/conformance/suites.json`.

The module is not marked ported (`RUST_PORTED_MODULES`) until every group is.
