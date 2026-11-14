//! WeldSuite's own MTA (ADR MAIL-011): how the Kubernetes editions send mail
//! without Cloudflare or a third-party relay. `weldsuite mta` runs it on the
//! mail nodes, one pool per node set (`system` for WeldSuite's own mail,
//! `customer` for everything users write), each node sending from its own
//! public IPv4 with matching reverse DNS. Contract:
//! `weldsuite-documentation/plans/eu-mail-service.md`.
//!
//! Written from the ground up, on purpose: no mail or DNS libraries.
//!
//! - [`smtp`]: the protocol both ways ([`smtp::server`] for submission and
//!   the bounce MX, [`smtp::client`] for delivery).
//! - [`dns`]: a stub resolver (MX with null MX and implicit MX, A, TXT,
//!   PTR).
//! - [`message`], [`dkim`]: RFC 5322 bytes and DKIM signing.
//! - [`store`]: the queue, domains, suppressions, counters and the event
//!   outbox in the MTA's own Postgres database.
//! - [`submission`]: the submission policy (auth → pool, sender and
//!   suppression checks, enqueue).
//! - [`delivery`], [`shaping`], [`retry`]: the delivery workers.
//! - [`verp`], [`feedback`], [`inbound`]: the return path (VERP addresses,
//!   DSN and ARF reports, the bounce MX).
//! - [`mta_sts`], [`tlsrpt`]: MTA-STS policies and TLS-RPT reports.
//! - [`events`]: delivery events in Cloudflare Email Sending's shape, from
//!   the outbox to NATS.
//! - [`api`]: the HTTP API (domains, queue, health).
//! - [`monitoring`]: the Prometheus metrics (deliveries, the database pool).
//! - [`config`], [`run`]: settings and the process.

pub mod api;
pub mod config;
pub mod crypto;
pub mod delivery;
pub mod dkim;
pub mod dns;
pub mod domains;
pub mod events;
pub mod feedback;
pub mod inbound;
pub mod message;
pub mod monitoring;
pub mod mta_sts;
pub mod retry;
pub mod run;
pub mod shaping;
pub mod smtp;
pub mod store;
pub mod submission;
pub mod tls;
pub mod tlsrpt;
pub mod verp;

#[cfg(test)]
mod e2e;

/// A boxed, sendable future (object-safe async trait methods).
pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
