//! mail-api's Cron Triggers, as `weldsuite cron <name>` jobs:
//!
//! - `mail-outbound-ledgers` (every 5 minutes): the ledgers' alarm (risk
//!   score, automatic actions, the platform push, pruning), which a Durable
//!   Object ran on its own alarm (`StoreLedger::sweep`).
//!
//! The snooze sweep on the same trigger belongs to the mailbox workstream.

use weldsuite_mail_domain::outbound::{LedgerResult, StoreLedger};

/// `weldsuite cron mail-outbound-ledgers`: how many ledgers ran.
pub async fn outbound_ledgers(ledger: &StoreLedger) -> LedgerResult<usize> {
    ledger.sweep().await
}
