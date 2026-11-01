//! `@weldsuite/mail-domain` (`packages/domains/mail`): what the modules that
//! read or send mail share. One Rust module per TypeScript subpath, so the
//! Calendar, Desk and Mail ports extend it in place:
//!
//! - [`access`] (`./access`): who may open a mailbox (MAIL-003).
//! - [`store`] (`./store`): a workspace's mailbox contents. On Kubernetes
//!   they stay in the tenant Postgres tables (`weldmail-mailbox-store` is
//!   `postgres` there, MAIL-010); the Durable Object modes are
//!   TypeScript-only.
//! - [`outbound`] (`./outbound`): the outbound guard; the Mail-outbound
//!   workstream fills it in.
//! - [`domains`]: the `MailDomains` port for custom domains on Kubernetes
//!   (MAIL-010), in place of the Cloudflare Email Routing API.
//!
//! Small on purpose: add what a ported route uses, with the TypeScript
//! function it mirrors named in its doc comment.

pub mod access;
pub mod contacts;
pub mod domains;
pub mod html;
pub mod labels;
pub mod messages;
pub mod outbound;
pub mod recipients;
pub mod send;
pub mod store;
pub mod text;
pub mod threads;
