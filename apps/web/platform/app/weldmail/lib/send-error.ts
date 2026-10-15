/**
 * Turns a failed WeldMail send into something a person can act on.
 *
 * The send endpoints (compose, reply, forward, scheduled) answer with
 * `{ error: { code, message, details } }`; the outbound guard's codes carry an
 * `OutboundDenialDetails` (which window is full, when a retry can work, and
 * whether to point at WeldReach). Pure and i18n-free: the caller passes the
 * translated labels, so it is easy to test. See
 * docs/plans/weldmail-outbound-abuse.md, "Customer experience".
 */

import type { OutboundDenialCode } from '@weldsuite/app-api-client/schemas/outbound-mail';

/** The failed part of a `mailApi.*` result (`ApiResponse` in `api-client.ts`). */
export interface SendFailure {
  error?: string;
  /** Backend code, e.g. `SENDING_LIMITED`. */
  errorCode?: string;
  /** Whatever the backend attached (`OutboundDenialDetails`, `{ sent, failed }`, …). */
  errorDetails?: unknown;
}

/** `t.mail.sending.errors`. */
export interface SendErrorLabels {
  sendingLimited: { hour: string; day: string; month: string; generic: string };
  limitLine: { hour: string; day: string; month: string; message: string; newContactsDay: string };
  retryAt: string;
  retryNow: string;
  contactSupportLimit: string;
  contactSupport: string;
  firstContactLimited: {
    default: string;
    coldOutreachTemplate: string;
    sharedDomain: string;
    repliesNote: string;
  };
  platformLimited: string;
  onHold: string;
  suspended: string;
  senderNotOwned: string;
  tooManyRecipients: string;
  recipientSuppressed: string;
  recipientSuppressedNamed: string;
  providerRateLimited: string;
  providerDailyLimit: string;
  partiallySent: string;
  partiallySentHelp: string;
  dailyLimitReached: string;
  senderDomainNotVerified: string;
  invalidRecipients: string;
  invalidRecipientsNamed: string;
  emailTooLarge: string;
  andMore: string;
}

export interface DescribeSendErrorContext {
  /** Language for relative times (`en`, `nl`, …). */
  locale: string;
  /** Shown when the failure has no code we know and no message of its own. */
  fallback: string;
  /** For tests. */
  now?: Date;
}

export interface SendErrorView {
  /** What happened. */
  title: string;
  /** The limit, when it clears and what to do about it. */
  description?: string;
  /** Show the "outreach belongs in WeldReach" notice. */
  suggestWeldReach: boolean;
}

type DenialWindow = 'message' | 'hour' | 'day' | 'month';

const WINDOWS: ReadonlySet<string> = new Set<DenialWindow>(['message', 'hour', 'day', 'month']);

/** Denial codes the guard can answer with, so the mapping below stays exhaustive over them. */
const GUARD_CODES = {
  SENDING_LIMITED: 'SENDING_LIMITED',
  FIRST_CONTACT_LIMITED: 'FIRST_CONTACT_LIMITED',
  SENDING_ON_HOLD: 'SENDING_ON_HOLD',
  SENDING_SUSPENDED: 'SENDING_SUSPENDED',
  SENDER_NOT_OWNED: 'SENDER_NOT_OWNED',
  TOO_MANY_RECIPIENTS: 'TOO_MANY_RECIPIENTS',
  RECIPIENT_SUPPRESSED: 'RECIPIENT_SUPPRESSED',
  PLATFORM_LIMITED: 'PLATFORM_LIMITED',
} as const satisfies Record<OutboundDenialCode, OutboundDenialCode>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

function fill(template: string, values: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{${key}}`, String(value));
  return out;
}

/** "a, b, c and 2 more": long lists must not swallow the toast. */
function joinList(items: string[], andMore: string, max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} ${fill(andMore, { count: items.length - max })}`;
}

export type RetryHint = { kind: 'now' } | { kind: 'at'; when: string };

/**
 * When a retry can succeed, as a relative time in the reader's language ("in 12
 * minutes", "in 3 hours", "tomorrow"). `null` when `retryAfter` is missing or
 * not a date.
 */
export function describeRetry(
  retryAfter: string | undefined,
  now: Date,
  locale: string,
): RetryHint | null {
  if (!retryAfter) return null;
  const target = new Date(retryAfter);
  const diffMs = target.getTime() - now.getTime();
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return { kind: 'now' };

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return { kind: 'at', when: rtf.format(minutes, 'minute') };
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return { kind: 'at', when: rtf.format(hours, 'hour') };
  return { kind: 'at', when: rtf.format(Math.ceil(hours / 24), 'day') };
}

/** One sentence for the retry hint, or `undefined` when there is none. */
function retryLine(
  retryAfter: string | undefined,
  labels: SendErrorLabels,
  ctx: DescribeSendErrorContext,
): string | undefined {
  const hint = describeRetry(retryAfter, ctx.now ?? new Date(), ctx.locale);
  if (!hint) return undefined;
  return hint.kind === 'now' ? labels.retryNow : fill(labels.retryAt, { when: hint.when });
}

function join(lines: (string | undefined)[]): string | undefined {
  const text = lines.filter((l): l is string => Boolean(l)).join(' ');
  return text || undefined;
}

interface Parsed {
  window: DenialWindow | undefined;
  limit: number | undefined;
  retryAfter: string | undefined;
  reason: string | undefined;
  suggestWeldReach: boolean;
  details: Record<string, unknown>;
}

function parseDetails(raw: unknown): Parsed {
  const details = asRecord(raw);
  const window = typeof details.window === 'string' && WINDOWS.has(details.window)
    ? (details.window as DenialWindow)
    : undefined;
  return {
    window,
    limit: typeof details.limit === 'number' ? details.limit : undefined,
    retryAfter: typeof details.retryAfter === 'string' ? details.retryAfter : undefined,
    reason: typeof details.reason === 'string' ? details.reason : undefined,
    suggestWeldReach: details.suggestWeldReach === true,
    details,
  };
}

function limitLine(
  labels: SendErrorLabels,
  window: DenialWindow | undefined,
  limit: number | undefined,
  locale: string,
): string | undefined {
  if (limit === undefined || window === undefined) return undefined;
  return fill(labels.limitLine[window], { limit: limit.toLocaleString(locale) });
}

function sendingLimited(p: Parsed, labels: SendErrorLabels, ctx: DescribeSendErrorContext): SendErrorView {
  const windowKey = p.window === 'hour' || p.window === 'day' || p.window === 'month' ? p.window : 'generic';
  return {
    title: labels.sendingLimited[windowKey],
    description: join([
      limitLine(labels, p.window, p.limit, ctx.locale),
      retryLine(p.retryAfter, labels, ctx) ?? labels.contactSupportLimit,
    ]),
    suggestWeldReach: p.suggestWeldReach,
  };
}

function firstContactLimited(p: Parsed, labels: SendErrorLabels, ctx: DescribeSendErrorContext): SendErrorView {
  const fc = labels.firstContactLimited;
  let title = fc.default;
  if (p.reason === 'cold_outreach_template') title = fc.coldOutreachTemplate;
  else if (p.reason === 'weldmail_shared_domain') title = fc.sharedDomain;
  return {
    title,
    description: join([
      p.limit === undefined
        ? undefined
        : fill(labels.limitLine.newContactsDay, { limit: p.limit.toLocaleString(ctx.locale) }),
      retryLine(p.retryAfter, labels, ctx),
      fc.repliesNote,
    ]),
    // Whatever tripped the first-contact cap, this is where outreach belongs.
    suggestWeldReach: true,
  };
}

function partiallySent(
  failure: SendFailure,
  p: Parsed,
  labels: SendErrorLabels,
  ctx: DescribeSendErrorContext,
): SendErrorView {
  const sent = asStrings(p.details.sent);
  const failed = asStrings(p.details.failed);
  if (sent.length === 0 && failed.length === 0) {
    return { title: failure.error?.trim() || ctx.fallback, suggestWeldReach: false };
  }
  return {
    title: fill(labels.partiallySent, {
      sent: joinList(sent, labels.andMore),
      failed: joinList(failed, labels.andMore),
    }),
    description: labels.partiallySentHelp,
    suggestWeldReach: false,
  };
}

function invalidRecipients(p: Parsed, labels: SendErrorLabels): SendErrorView {
  const bad = [...asStrings(p.details.invalidFormat), ...asStrings(p.details.unreachableDomains)];
  return {
    title: bad.length > 0
      ? fill(labels.invalidRecipientsNamed, { recipients: joinList(bad, labels.andMore) })
      : labels.invalidRecipients,
    suggestWeldReach: false,
  };
}

function recipientSuppressed(p: Parsed, labels: SendErrorLabels): SendErrorView {
  const recipients = asStrings(p.details.recipients);
  return {
    title: recipients.length > 0
      ? fill(labels.recipientSuppressedNamed, { recipients: joinList(recipients, labels.andMore) })
      : labels.recipientSuppressed,
    suggestWeldReach: false,
  };
}

/**
 * The message for a failed send. A code we have no text for falls back to the
 * backend's own message, then to `ctx.fallback` (the call site's generic
 * "failed to send").
 */
export function describeSendError(
  failure: SendFailure,
  labels: SendErrorLabels,
  ctx: DescribeSendErrorContext,
): SendErrorView {
  const p = parseDetails(failure.errorDetails);
  const plain = (title: string, description?: string): SendErrorView => ({
    title,
    description,
    suggestWeldReach: p.suggestWeldReach,
  });

  switch (failure.errorCode) {
    case GUARD_CODES.SENDING_LIMITED:
      return sendingLimited(p, labels, ctx);
    case GUARD_CODES.FIRST_CONTACT_LIMITED:
      return firstContactLimited(p, labels, ctx);
    case GUARD_CODES.PLATFORM_LIMITED:
      return plain(labels.platformLimited, retryLine(p.retryAfter, labels, ctx));
    case GUARD_CODES.SENDING_ON_HOLD:
      return plain(labels.onHold, labels.contactSupport);
    case GUARD_CODES.SENDING_SUSPENDED:
      return plain(labels.suspended);
    case GUARD_CODES.SENDER_NOT_OWNED:
      return plain(labels.senderNotOwned);
    case GUARD_CODES.TOO_MANY_RECIPIENTS:
      return plain(labels.tooManyRecipients, limitLine(labels, 'message', p.limit, ctx.locale));
    case GUARD_CODES.RECIPIENT_SUPPRESSED:
      return recipientSuppressed(p, labels);
    case 'PROVIDER_RATE_LIMITED':
      return plain(labels.providerRateLimited, retryLine(p.retryAfter, labels, ctx));
    case 'PROVIDER_DAILY_LIMIT':
      return plain(labels.providerDailyLimit, retryLine(p.retryAfter, labels, ctx));
    case 'PARTIALLY_SENT':
      return partiallySent(failure, p, labels, ctx);
    case 'DAILY_LIMIT_REACHED':
      return plain(labels.dailyLimitReached, retryLine(p.retryAfter, labels, ctx));
    case 'SENDER_DOMAIN_NOT_VERIFIED':
      return plain(labels.senderDomainNotVerified);
    case 'INVALID_RECIPIENTS':
      return invalidRecipients(p, labels);
    case 'EMAIL_TOO_LARGE':
      return plain(labels.emailTooLarge);
    default:
      return plain(failure.error?.trim() || ctx.fallback);
  }
}
