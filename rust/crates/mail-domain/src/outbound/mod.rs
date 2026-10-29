//! The outbound mail guard (`@weldsuite/mail-domain/outbound`, ADR MAIL-006
//! and MAIL-010): the one check every send of user-written mail goes through
//! before it reaches a transport, whichever module sends it (WeldMail
//! compose, reply, forward and scheduled sends, the public API, CRM
//! sequences, WeldConnect, WeldDesk replies, calendar and WeldMeet
//! invitations), and the transport it then goes out on.
//!
//! A send path builds a [`CheckOutboundInput`] and wraps its transmit in
//! [`guarded_send`] (or calls [`check_outbound`], transmits, then
//! [`commit_outbound`] / [`release_outbound`]); [`send_email`] builds the
//! message ([`mime`]) and hands it to a [`weldsuite_ports::MailTransport`],
//! one envelope per recipient.
//!
//! | TypeScript | Here |
//! |---|---|
//! | `guard.ts` | [`guard`] |
//! | `ledger-core.ts` | [`ledger_core`] |
//! | `ledger.ts` (`OutboundLedger`, `OutboundPlatformBudget` Durable Objects) | [`ledger`]: the [`OutboundLedger`] / [`PlatformBudget`] traits, [`StoreLedger`] over a `LedgerStore` (Valkey) |
//! | `policy-store.ts`, `cases.ts`, `correspondents.ts` | [`policy_store`], [`cases`], [`correspondents`] |
//! | `content-screen.ts`, `fingerprint.ts`, `risk.ts` | [`content_screen`], [`fingerprint`], [`risk`] |
//! | `review.ts`, `consumers.ts`, `delivery-events.ts` | [`review`], [`delivery_events`] |
//! | `@weldsuite/app-api-client/schemas/outbound-mail` | [`limits`] |
//! | `@weldsuite/email/core/mime` (`buildRfc5322`) | [`mime`] |
//! | `@weldsuite/worker-email` `sendEmail` + the Cloudflare send provider | [`transmit`] |

pub mod bindings;
pub mod cases;
pub mod clock;
pub mod content_screen;
pub mod correspondents;
pub mod delivery_events;
pub mod fingerprint;
pub mod guard;
pub mod ledger;
pub mod ledger_core;
pub mod limits;
pub mod mime;
pub mod policy_store;
pub mod review;
pub mod risk;
pub mod transmit;

pub use bindings::{OutboundBindings, RequestOutbound};
pub use guard::{
    Backstop, CheckOutboundInput, GuardedSendError, OutboundDenied, OutboundGuard,
    OutboundReservation, ReservationMode, SenderOwnership, SentRecipients, SubjectInput,
    WindowBackstop, bare_address, check_outbound, commit_outbound, get_outbound_usage,
    guarded_send, is_sender_owned, release_outbound, sender_ownership, trip_platform_breaker,
    unique_addresses,
};
pub use ledger::{
    Inspection, LedgerDeps, LedgerError, LedgerResult, OutboundLedger, OutboundReviewMessage,
    PlatformBudget, PlatformStatus, ReviewQueue, StoreLedger,
};
pub use ledger_core::{LedgerSubject, OutboundUsage, ReserveDecision, ReserveRequest};
pub use limits::{DenialCode, DenialDetails, GuardMode, OutboundKind, denial_message};
pub use mime::{BuiltEmail, MailAddress, MimeAttachment, MimeMessage, build_rfc5322};
pub use transmit::{Refusal, SendEmailParams, SendEmailResponse, TransmitError, send_email};
