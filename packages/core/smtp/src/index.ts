/**
 * @weldsuite/smtp — an SMTP submission client for Cloudflare Workers.
 *
 * Talks to a mail provider's submission server (Gmail, Mailpool's shared
 * servers, …) over `cloudflare:sockets`: implicit TLS on 465, STARTTLS on 587,
 * AUTH PLAIN/LOGIN. Port 25 is blocked on Workers and is not supported.
 *
 * Used by WeldReach (apps/workers/reach-api) to send outreach from Mailpool
 * mailboxes; see docs/plans/weldreach.md. The socket is injectable so the
 * protocol is unit-tested against scripted servers.
 *
 * CONTRACT (other packages code against these names; keep them stable):
 *   buildMimeMessage(message) → raw RFC 5322 text (CRLF line endings)
 *   sendMail(config, envelope, raw, options?) → SmtpSendResult (never throws for SMTP errors)
 *   generateMessageId(domain) → "<random>@domain" (no angle brackets)
 */

export type {
  SmtpConfig,
  SmtpEnvelope,
  SmtpSendResult,
  SmtpStage,
  SmtpSocket,
  SmtpSocketFactory,
  SendMailOptions,
  OutgoingMessage,
  MailAddress,
} from './types';
export { buildMimeMessage, generateMessageId } from './mime';
export { sendMail } from './client';
