//! The WeldReach warmup network (`apps/workers/reach-warmup-worker`) on the
//! Kubernetes editions: pool mailboxes write plain-text threads to each other
//! over their own SMTP logins, and the recipient's mailbox is engaged over
//! IMAP (found, rescued from Junk, opened, sometimes answered), so every
//! mailbox builds a sending reputation before it carries a campaign.
//!
//! - [`clock`]: randomness, business hours and the day's send times.
//! - [`pairing`]: who writes to whom.
//! - [`corpus`]: the threads and their rendering.

pub mod clock;
pub mod corpus;
pub mod pairing;
