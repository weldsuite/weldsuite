/**
 * `@weldsuite/mail-domain/outbound` — what send paths import: the guard and
 * its error. The Durable Objects (`./outbound/ledger`) and the queue consumers
 * (`./outbound/consumers`) are imported by mail-api only, so other workers
 * don't bundle the AI SDK or the email templates.
 *
 * See docs/plans/weldmail-outbound-abuse.md.
 */

export {
  checkOutbound,
  commitOutbound,
  releaseOutbound,
  guardedSend,
  tripPlatformBreaker,
  getOutboundUsage,
  isSenderOwned,
  senderOwnership,
  bareAddress,
  denialMessage,
  OutboundDeniedError,
  type OutboundGuardEnv,
  type OutboundReservation,
  type OutboundSubjectInput,
  type CheckOutboundInput,
  type RateLimitBinding,
  type SenderOwnership,
} from './guard';
export { ledgerKeyFor, type LedgerSubject } from './ledger-core';
