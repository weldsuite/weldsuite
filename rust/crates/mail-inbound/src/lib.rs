//! WeldMail's inbound path on the Kubernetes editions (ADR MAIL-010): the
//! Rust port of `apps/workers/mail-inbound-worker`, which on Global receives
//! every message from Cloudflare Email Routing.
//!
//! On Kubernetes, Haraka is the MX. It asks [`rcpt`] (an internal endpoint
//! of `weldsuite serve`) at `RCPT TO` whether the master registry knows the
//! address (MAIL-002), verifies SPF, DKIM and DMARC into an
//! `Authentication-Results` header in Cloudflare's form, puts the raw MIME
//! in the mail bucket and publishes its key with the envelope on
//! `mail.inbound`. [`consumer`] (`weldsuite consume`) then runs what the
//! worker runs: one module per worker file, named in its docs.
//!
//! - [`mime`]: postal-mime, the parser `parseRawEmail` runs.
//! - [`parsed`]: `parseRawEmail` + the `Authentication-Results` read +
//!   `cf-email-adapter.ts`.
//! - [`spam`], [`promotion`], [`thread_match`], [`catch_all`],
//!   [`unsubscribe`], [`rules`]: the pure rules (`spam-filter.ts`,
//!   `promotion-filter.ts`, `thread-match.ts`, `catch-all.ts`,
//!   `list-unsubscribe`, the mail-rule model).
//! - [`recipients`], [`store`], [`deliver`], [`push`]: `email-storage.ts`'s
//!   workspace path, `notify-recipients.ts`, `push-notifications.ts`,
//!   `expo-push.ts`, `contact-upsert.ts`; realtime as `realtime.ts`.
//! - [`fanout`]: `desk-inbound.ts` and the helpdesk and accounting inboxes,
//!   each only when the edition serves its module.
//!
//! Not ported, on purpose: consumer WeldMail's personal mailboxes
//! (MAIL-008 is not part of the Kubernetes editions), the mailbox Durable
//! Object modes (MAIL-010 keeps the Postgres store), and the Jev
//! auto-labels (Workers AI; mail AI is an unavailable feature).

pub mod catch_all;
pub mod consumer;
pub mod context;
pub mod deliver;
pub mod fanout;
pub mod mime;
pub mod parsed;
pub mod promotion;
pub mod push;
pub mod rcpt;
pub mod recipients;
pub mod rules;
pub mod spam;
pub mod store;
pub mod thread_match;
pub mod unsubscribe;

pub use consumer::{InboundEnvelope, MailInboundSubscriber};
pub use context::{FanOut, InboundContext, StaticDbs, TenantDbs, WorkspaceDbs};
