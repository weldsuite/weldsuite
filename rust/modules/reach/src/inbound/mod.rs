//! WeldReach's inbound path (`email/handler.ts`, `services/inbound.ts`,
//! `lib/inbound/*`): the replies, automatic replies and bounces Mailpool
//! forwards from each mailbox to `reply+<token>@REACH_INBOUND_DOMAIN`.
//!
//! - [`parse`]: the message (postal-mime's port), Message-IDs, the token.
//! - [`rules`], [`bounce`]: auto-replies, the opt-out rule, the kind, and
//!   delivery status notifications.
//! - [`deliver`]: matching, storing and the effects (`deliverInbound`).
//! - [`handler`]: routing a recipient to its workspace and mailbox, the
//!   warmup screen and the RCPT check ([`ReachInbound`]).
//! - [`consume`]: the replies taken out of `mail.inbound`
//!   ([`ReachInboundRouter`]).

pub mod bounce;
pub mod consume;
pub mod deliver;
pub mod handler;
pub mod parse;
pub mod rules;

pub use consume::ReachInboundRouter;
pub use deliver::{DeliverInput, DeliverResult, InboundMailbox, deliver_inbound};
pub use handler::{Dropped, InboundTenants, ReachInbound, accepts_recipient};
