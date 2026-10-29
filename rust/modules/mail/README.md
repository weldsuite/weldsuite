# weldsuite-mail

WeldMail's API as `apps/workers/mail-api` serves it, on the Kubernetes
editions (module id `mail`, ADR API-014 and MAIL-010). Shared mail logic
(mailbox access, the Postgres mailbox store, the outbound guard and the
transport) lives in `rust/crates/mail-domain`, which Calendar, Desk and CRM
send through too.

One Rust module per mail-api route group (`src/routes/<group>.rs`), each with
a `routes()` function at its paths relative to `/api`; `src/lib.rs` assembles
them. Groups outside `/api` (`/internal/*`) have their own router. Four
workstreams fill this crate in; add your group's line here when it lands.

| Route group (mail-api) | Rust module | Workstream | Status |
|---|---|---|---|
| `/api/mail-sending` | `routes::mail_sending` | outbound | ported |
| `/internal/outbound` | `routes::internal_outbound` | outbound | ported |
| `/api/mail-accounts/:id/send` | `routes::mail_accounts` (send only) | outbound | in progress |
| `/api/mail-messages/:id/reply`, `/:id/forward` | `routes::mail_messages` (sends only) | outbound | in progress |
| `/api/mail-scheduled` | `routes::mail_scheduled` | outbound | in progress |
| `mail-sending-events`, `mail-outbound-review` consumers | `consumers` | outbound | handlers ported |
| outbound-alerts cron | `cron::outbound_alerts` | outbound | in progress |
| `/api/mail-messages` reads, `/api/mail-threads`, `/api/mail-labels`, `/api/mail-folders`, `/api/mail-drafts`, … | | mailbox store | not started |
| `/api/mailboxes`, `/api/mail-accounts` (CRUD), `/api/mail-domains`, `/api/mail-weldmail` | | accounts and domains | not started |
| inbound (mail-inbound-worker) | | inbound | not started |

The module is not marked ported (`RUST_PORTED_MODULES`) until every group is.
