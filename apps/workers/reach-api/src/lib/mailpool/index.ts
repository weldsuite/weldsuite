/**
 * Mailpool client for reach-api. See `client.ts` for the transport rules and
 * `types.ts` for the endpoints and shapes modelled.
 */

export {
  createMailpoolClient,
  MAILPOOL_CLOUDFLARE_CONNECT_PATH,
  MAILPOOL_CLOUDFLARE_ZONES_PATH,
  MAILPOOL_DEFAULT_BASE_URL,
  MAX_RETRIES,
  type MailpoolClient,
  type MailpoolClientOptions,
} from './client';
export { extractMessage, isMailpoolNotFound, MailpoolError, MailpoolNotConfiguredError } from './errors';
export * from './types';

import type { ReachMailServerCredentials } from '@weldsuite/db/schema';
import type { MailpoolMailbox } from './types';

function toPort(value: number | string | undefined): number | null {
  const port = typeof value === 'string' ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * SMTP login of a Mailpool mailbox, in the shape `reach_mailboxes` stores it
 * (sealed). null when Mailpool did not return a usable login (outlook
 * mailboxes, or a mailbox still provisioning).
 *
 * `tls` mirrors Mailpool's `smtpTLS` flag only; whether to connect with
 * implicit TLS or STARTTLS follows from the port (465 / 587), see
 * `@weldsuite/smtp` SmtpConfig.
 */
export function smtpCredentialsOf(mailbox: MailpoolMailbox): ReachMailServerCredentials | null {
  const port = toPort(mailbox.smtpPort);
  if (!mailbox.smtpHost || port === null || !mailbox.smtpUsername || !mailbox.smtpPassword) return null;
  return {
    host: mailbox.smtpHost,
    port,
    tls: mailbox.smtpTLS !== false,
    username: mailbox.smtpUsername,
    password: mailbox.smtpPassword,
  };
}

/** IMAP login (kept for a later IMAP fallback), same rules as `smtpCredentialsOf`. */
export function imapCredentialsOf(mailbox: MailpoolMailbox): ReachMailServerCredentials | null {
  const port = toPort(mailbox.imapPort);
  if (!mailbox.imapHost || port === null || !mailbox.imapUsername || !mailbox.imapPassword) return null;
  return {
    host: mailbox.imapHost,
    port,
    tls: mailbox.imapTLS !== false,
    username: mailbox.imapUsername,
    password: mailbox.imapPassword,
  };
}
