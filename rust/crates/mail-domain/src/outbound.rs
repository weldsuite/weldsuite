//! The outbound mail guard (`@weldsuite/mail-domain/outbound`): every send
//! checked against the workspace's outbound ledger and the platform budget
//! before it goes out (docs/plans/weldmail-outbound-abuse.md).
//!
//! Owned by the Mail-outbound workstream, which adds the guard here
//! (`guarded_send`), the `MailTransport` port (an SMTP relay on Kubernetes)
//! and the `OutboundLedger` (Valkey). Empty until then.
