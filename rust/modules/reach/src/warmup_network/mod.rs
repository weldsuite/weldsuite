//! The WeldReach warmup network (`apps/workers/reach-warmup-worker`) on the
//! Kubernetes editions: pool mailboxes write plain-text threads to each other
//! over their own SMTP logins, and the recipient's mailbox is engaged over
//! IMAP (found, rescued from Junk, opened, sometimes answered), so every
//! mailbox builds a sending reputation before it carries a campaign.
//!
//! - [`clock`]: randomness, business hours and the day's send times.
//! - [`pairing`]: who writes to whom.
//! - [`corpus`]: the threads and their rendering: the generated set kept in
//!   the master database, else the built-in one; [`generate`] refreshes it
//!   monthly with the install's AI, [`validate`] checks every thread.
//! - [`planner`] (`weldsuite cron reach-warmup-plan`, every 30 minutes,
//!   with [`login_recheck`]): turns the pool into scheduled messages.
//! - [`dispatch`] (`weldsuite cron reach-warmup-dispatch`, every minute):
//!   hands due messages to [`send`] and [`engage`], over NATS or inline.
//! - [`daily`] (`weldsuite cron reach-warmup-daily`, 02:30 UTC): the ramp,
//!   [`stats`], auto-pause and resume, [`cleanup`], the corpus refresh.
//! - [`pool_state`]: the states the engine sets on pool mailboxes, and the
//!   due index that tells the warmup sweep.
//!
//! Master database only. The kill switch is the `weldreach-warmup` flag.

use std::sync::Arc;

use sqlx::PgPool;
use weldsuite_ports::{DynFlagSource, ImapConnector};
use weldsuite_reach_domain::smtp::SmtpTransport;

pub mod cleanup;
pub mod clock;
pub mod corpus;
pub mod daily;
pub mod db;
pub mod dispatch;
pub mod engage;
pub mod generate;
pub mod login_recheck;
pub mod pairing;
pub mod planner;
pub mod pool_state;
pub mod send;
pub mod stats;
pub mod validate;

/// What the warmup jobs need (`Env` of reach-warmup-worker).
#[derive(Clone)]
pub struct WarmupNetwork {
    /// The master database (pool and messages).
    pub master: PgPool,
    /// `WELDREACH_WARMUP_KEY`: opens the pool mailboxes' logins.
    pub warmup_key: Option<String>,
    /// SMTP for the sends (lettre in production).
    pub smtp: Arc<dyn SmtpTransport>,
    /// IMAP for engagements, login rechecks and cleanup.
    pub imap: Arc<dyn ImapConnector>,
    /// Where the `weldreach-warmup` kill switch is read.
    pub flags: Arc<dyn DynFlagSource>,
    /// The install's AI, which writes the corpus monthly (`reach-warmup`);
    /// `None`: the built-in corpus only.
    pub ai: Option<weldsuite_ai::Ai>,
}
