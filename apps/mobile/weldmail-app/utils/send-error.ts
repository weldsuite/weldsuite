/**
 * Turns a failed WeldMail send into a message a person can act on.
 *
 * The send endpoints answer with `{ error: { code, message, details } }`; the
 * outbound guard's codes carry which limit was hit, when a retry can work and
 * whether to point at WeldReach (docs/plans/weldmail-outbound-abuse.md). Pure,
 * so the composer's alert can be tested without rendering the screen. The app
 * has no i18n layer yet, so the copy is English like the rest of the composer;
 * the web platform's twin is `app/weldmail/lib/send-error.ts`.
 */

import { isApiError } from '@weldsuite/api-client/client';

export interface SendErrorAlert {
  title: string;
  message: string;
}

type Details = Record<string, unknown>;

function asRecord(value: unknown): Details {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Details) : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/** The `{ code, message, details }` an API error response carried; null for any other failure. */
export function readApiError(err: unknown): { code: string; message: string; details: Details } | null {
  if (!isApiError(err)) return null;
  const error = asRecord(asRecord(err.body).error);
  const code = typeof error.code === 'string' ? error.code : '';
  if (!code) return null;
  return {
    code,
    message: typeof error.message === 'string' ? error.message : '',
    details: asRecord(error.details),
  };
}

/**
 * The server's own explanation of a refusal, for failures {@link describeSendError}
 * has no copy for. Only 4xx responses qualify: they say what the person can fix.
 * A 5xx message is an internal one, so the caller shows its translated fallback.
 */
export function serverErrorMessage(err: unknown): string | null {
  if (!isApiError(err) || err.status >= 500) return null;
  const message = asRecord(asRecord(err.body).error).message;
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

/** "in 25 minutes", "in 3 hours", "tomorrow", "in 3 days"; null when `retryAfter` is not a date. */
export function describeRetryAfter(retryAfter: unknown, now: Date): string | null {
  if (typeof retryAfter !== 'string') return null;
  const diffMs = new Date(retryAfter).getTime() - now.getTime();
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return 'in a moment';
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return minutes === 1 ? 'in 1 minute' : `in ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

function list(items: string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

const WELDREACH_HINT =
  'WeldMail is for one-to-one email. For outreach campaigns to people who do not know you yet, use WeldReach: a workspace admin can request access in the App Store on the web.';

const WINDOW_TITLE: Record<string, string> = {
  hour: 'Hourly limit reached',
  day: 'Daily limit reached',
  month: 'Monthly limit reached',
};

const WINDOW_UNIT: Record<string, string> = {
  hour: 'per hour',
  day: 'per day',
  month: 'per month',
  message: 'per message',
};

function limitSentence(details: Details, unit: string | undefined): string | null {
  const limit = details.limit;
  if (typeof limit !== 'number' || !unit) return null;
  return `Limit: ${limit.toLocaleString('en')} recipients ${unit}.`;
}

function retrySentence(details: Details, now: Date): string | null {
  const when = describeRetryAfter(details.retryAfter, now);
  return when ? `You can send again ${when}.` : null;
}

function join(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function sendingLimited(details: Details, now: Date): SendErrorAlert {
  const window = typeof details.window === 'string' ? details.window : '';
  return {
    title: WINDOW_TITLE[window] ?? 'Sending limit reached',
    message: join([
      'You have reached a sending limit.',
      limitSentence(details, WINDOW_UNIT[window]),
      retrySentence(details, now) ?? 'Contact support if you need a higher limit.',
      details.suggestWeldReach === true ? WELDREACH_HINT : null,
    ]),
  };
}

function firstContactLimited(details: Details, now: Date): SendErrorAlert {
  let reason = "You have reached today's limit for emailing people who have not written to you first.";
  if (details.reason === 'cold_outreach_template') {
    reason = 'Messages like this one are limited when they go to many people who have not written to you first.';
  } else if (details.reason === 'weldmail_shared_domain') {
    reason = 'Addresses on weldmail.com have a low daily limit for new contacts. Connect your own domain to send more.';
  }
  const limit = typeof details.limit === 'number' ? `Limit: ${details.limit.toLocaleString('en')} new contacts per day.` : null;
  return {
    title: 'New contacts limit reached',
    message: join([
      reason,
      limit,
      retrySentence(details, now),
      'Replies to people who wrote to you are not affected.',
      WELDREACH_HINT,
    ]),
  };
}

function partiallySent(details: Details): SendErrorAlert | null {
  const sent = asStrings(details.sent);
  const failed = asStrings(details.failed);
  if (sent.length === 0 && failed.length === 0) return null;
  return {
    title: 'Partly sent',
    message: join([
      `The message reached ${list(sent)} but not ${list(failed)}.`,
      'It is saved in Sent. Remove the people who already have it before you send again, or they will get it twice.',
    ]),
  };
}

function recipientsAlert(code: string, details: Details): SendErrorAlert | null {
  if (code === 'RECIPIENT_SUPPRESSED') {
    const recipients = asStrings(details.recipients);
    return {
      title: 'Recipient unavailable',
      message: join([
        recipients.length > 0
          ? `These recipients asked not to receive mail from your workspace: ${list(recipients)}.`
          : 'Some recipients asked not to receive mail from your workspace.',
        'Remove them and send again.',
      ]),
    };
  }
  if (code === 'INVALID_RECIPIENTS') {
    const bad = [...asStrings(details.invalidFormat), ...asStrings(details.unreachableDomains)];
    return {
      title: 'Invalid recipients',
      message: bad.length > 0
        ? `These recipient addresses cannot be used: ${list(bad)}.`
        : 'One or more recipient addresses are invalid.',
    };
  }
  return null;
}

function simpleAlert(code: string, details: Details, now: Date): SendErrorAlert | null {
  switch (code) {
    case 'PLATFORM_LIMITED':
      return {
        title: 'New contacts paused',
        message: join([
          'WeldMail is at its sending capacity for today, so mail to new contacts is paused. Replies still go through.',
          retrySentence(details, now),
        ]),
      };
    case 'SENDING_ON_HOLD':
      return {
        title: 'New conversations paused',
        message:
          "New conversations are paused while we review your workspace's sending. You can still reply to messages you have received. Contact support if you think this is a mistake.",
      };
    case 'SENDING_SUSPENDED':
      return {
        title: 'Sending suspended',
        message: 'Sending is suspended for your workspace. Contact support to get it restored.',
      };
    case 'SENDER_NOT_OWNED':
      return {
        title: "Can't send from this address",
        message: 'You cannot send from this address. It does not belong to your workspace.',
      };
    case 'TOO_MANY_RECIPIENTS':
      return {
        title: 'Too many recipients',
        message: join([
          'This message has too many recipients. Split it into several messages.',
          limitSentence(details, WINDOW_UNIT.message),
        ]),
      };
    case 'PROVIDER_RATE_LIMITED':
      return {
        title: 'Slow down for a moment',
        message: 'Our mail provider is slowing down sending for a moment. Try again shortly.',
      };
    case 'PROVIDER_DAILY_LIMIT':
      return {
        title: 'Mail temporarily unavailable',
        message: 'Mail sending is temporarily unavailable. We have been notified, try again later.',
      };
    case 'DAILY_LIMIT_REACHED':
      return {
        title: 'Daily limit reached',
        message: join(['This mailbox has reached its daily sending limit.', retrySentence(details, now)]),
      };
    case 'SENDER_DOMAIN_NOT_VERIFIED':
      return {
        title: 'Domain not verified',
        message: 'The domain of this address is not verified yet. Check its DNS records in WeldHost, or send from another address.',
      };
    case 'EMAIL_TOO_LARGE':
      return {
        title: 'Email too large',
        message: 'This email is too large to send. Remove attachments or shorten the message.',
      };
    default:
      return null;
  }
}

/**
 * The alert for a failed send, or `null` when the failure is not one we have
 * words for (the caller then shows its own generic "failed to send").
 */
export function describeSendError(err: unknown, now: Date = new Date()): SendErrorAlert | null {
  const apiError = readApiError(err);
  if (!apiError) return null;
  const { code, details } = apiError;
  switch (code) {
    case 'SENDING_LIMITED':
      return sendingLimited(details, now);
    case 'FIRST_CONTACT_LIMITED':
      return firstContactLimited(details, now);
    case 'PARTIALLY_SENT':
      return partiallySent(details);
    case 'RECIPIENT_SUPPRESSED':
    case 'INVALID_RECIPIENTS':
      return recipientsAlert(code, details);
    default:
      return simpleAlert(code, details, now);
  }
}
