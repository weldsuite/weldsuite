import { describe, it, expect } from 'vitest';
import { OUTBOUND_DENIAL_CODES } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { describeRetry, describeSendError, type SendErrorLabels } from './send-error';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const labels: SendErrorLabels = en.mail.sending.errors;
const FALLBACK = 'Failed to send email';

function describe_(errorCode: string | undefined, errorDetails?: unknown, error?: string) {
  return describeSendError({ errorCode, errorDetails, error }, labels, { locale: 'en', fallback: FALLBACK, now: NOW });
}

function inMinutes(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

describe('describeRetry', () => {
  it('returns null without a usable date', () => {
    expect(describeRetry(undefined, NOW, 'en')).toBeNull();
    expect(describeRetry('not a date', NOW, 'en')).toBeNull();
  });

  it('says "now" once the time has passed', () => {
    expect(describeRetry(inMinutes(-5), NOW, 'en')).toEqual({ kind: 'now' });
  });

  it('counts minutes under an hour, hours under a day, days after that', () => {
    expect(describeRetry(inMinutes(12), NOW, 'en')).toEqual({ kind: 'at', when: 'in 12 minutes' });
    expect(describeRetry(inMinutes(3 * 60), NOW, 'en')).toEqual({ kind: 'at', when: 'in 3 hours' });
    expect(describeRetry(inMinutes(24 * 60), NOW, 'en')).toEqual({ kind: 'at', when: 'tomorrow' });
    expect(describeRetry(inMinutes(3 * 24 * 60), NOW, 'en')).toEqual({ kind: 'at', when: 'in 3 days' });
  });

  it('rounds up so a retry never lands early', () => {
    expect(describeRetry(inMinutes(0.2), NOW, 'en')).toEqual({ kind: 'at', when: 'in 1 minute' });
    expect(describeRetry(inMinutes(61), NOW, 'en')).toEqual({ kind: 'at', when: 'in 2 hours' });
  });

  it('speaks the reader\'s language', () => {
    expect(describeRetry(inMinutes(12), NOW, 'nl')).toEqual({ kind: 'at', when: 'over 12 minuten' });
  });
});

describe('describeSendError', () => {
  it('names the window and the limit for SENDING_LIMITED, with the reset time', () => {
    const view = describe_('SENDING_LIMITED', { code: 'SENDING_LIMITED', window: 'hour', limit: 30, used: 30, retryAfter: inMinutes(25) });
    expect(view.title).toBe(labels.sendingLimited.hour);
    expect(view.description).toBe('Limit: 30 recipients per hour. You can send again in 25 minutes.');
    expect(view.suggestWeldReach).toBe(false);
  });

  it('covers the daily and monthly windows', () => {
    expect(describe_('SENDING_LIMITED', { window: 'day', limit: 1500, retryAfter: inMinutes(5 * 60) })).toMatchObject({
      title: labels.sendingLimited.day,
      description: 'Limit: 1,500 recipients per day. You can send again in 5 hours.',
    });
    expect(describe_('SENDING_LIMITED', { window: 'month', limit: 10000, retryAfter: inMinutes(9 * 24 * 60) })).toMatchObject({
      title: labels.sendingLimited.month,
      description: 'Limit: 10,000 recipients per month. You can send again in 9 days.',
    });
  });

  it('sends the reader to support when only staff can lift a limit', () => {
    const view = describe_('SENDING_LIMITED', { window: 'day', limit: 150 });
    expect(view.description).toBe(`Limit: 150 recipients per day. ${labels.contactSupportLimit}`);
  });

  it('still explains a limit that came without details', () => {
    expect(describe_('SENDING_LIMITED')).toEqual({
      title: labels.sendingLimited.generic,
      description: labels.contactSupportLimit,
      suggestWeldReach: false,
    });
  });

  it('honours suggestWeldReach on any limit', () => {
    expect(describe_('SENDING_LIMITED', { window: 'day', limit: 10, suggestWeldReach: true }).suggestWeldReach).toBe(true);
  });

  it('always points outreach at WeldReach when first contact is limited', () => {
    const view = describe_('FIRST_CONTACT_LIMITED', {
      window: 'day',
      limit: 50,
      retryAfter: inMinutes(120),
      reason: 'workspace_first_contact',
    });
    expect(view.title).toBe(labels.firstContactLimited.default);
    expect(view.description).toBe(
      `Limit: 50 new contacts per day. You can send again in 2 hours. ${labels.firstContactLimited.repliesNote}`,
    );
    expect(view.suggestWeldReach).toBe(true);
    // Even without details.
    expect(describe_('FIRST_CONTACT_LIMITED').suggestWeldReach).toBe(true);
  });

  it('explains the cold-outreach template cap and the shared-domain cap', () => {
    expect(describe_('FIRST_CONTACT_LIMITED', { reason: 'cold_outreach_template', limit: 25 }).title).toBe(
      labels.firstContactLimited.coldOutreachTemplate,
    );
    expect(describe_('FIRST_CONTACT_LIMITED', { reason: 'weldmail_shared_domain', limit: 20 }).title).toBe(
      labels.firstContactLimited.sharedDomain,
    );
  });

  it('tells replies still work while on hold, and not to expect a retry time', () => {
    expect(describe_('SENDING_ON_HOLD')).toEqual({
      title: labels.onHold,
      description: labels.contactSupport,
      suggestWeldReach: false,
    });
    expect(labels.onHold).toContain('reply');
  });

  it('maps a suspension and a foreign sender address', () => {
    expect(describe_('SENDING_SUSPENDED').title).toBe(labels.suspended);
    expect(describe_('SENDER_NOT_OWNED').title).toBe(labels.senderNotOwned);
  });

  it('reports the platform budget with its reset time', () => {
    const view = describe_('PLATFORM_LIMITED', { retryAfter: inMinutes(6 * 60) });
    expect(view.title).toBe(labels.platformLimited);
    expect(view.description).toBe('You can send again in 6 hours.');
  });

  it('shows the per-message recipient cap', () => {
    expect(describe_('TOO_MANY_RECIPIENTS', { window: 'message', limit: 20 })).toMatchObject({
      title: labels.tooManyRecipients,
      description: 'Limit: 20 recipients per message.',
    });
  });

  it('names suppressed recipients, and copes with none', () => {
    expect(describe_('RECIPIENT_SUPPRESSED', { recipients: ['a@x.com', 'b@x.com'] }).title).toBe(
      'These recipients asked not to receive mail from your workspace: a@x.com, b@x.com. Remove them and send again.',
    );
    expect(describe_('RECIPIENT_SUPPRESSED').title).toBe(labels.recipientSuppressed);
  });

  it('abbreviates a long recipient list', () => {
    const recipients = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'];
    expect(describe_('RECIPIENT_SUPPRESSED', { recipients }).title).toContain('a@x.com, b@x.com, c@x.com and 2 more');
  });

  it('says who got a partially sent message and who did not', () => {
    const view = describe_('PARTIALLY_SENT', { sent: ['a@x.com'], failed: ['b@x.com', 'c@x.com'], messageId: 'msg_1' });
    expect(view.title).toBe('The message reached a@x.com but not b@x.com, c@x.com.');
    expect(view.description).toBe(labels.partiallySentHelp);
  });

  it('falls back to the backend message when a partial send has no lists', () => {
    expect(describe_('PARTIALLY_SENT', undefined, 'Sent to 1 of 3 recipients.').title).toBe('Sent to 1 of 3 recipients.');
  });

  it('maps the provider codes', () => {
    expect(describe_('PROVIDER_RATE_LIMITED', { retryAfter: inMinutes(1) })).toMatchObject({
      title: labels.providerRateLimited,
      description: 'You can send again in 1 minute.',
    });
    expect(describe_('PROVIDER_DAILY_LIMIT').title).toBe(labels.providerDailyLimit);
  });

  it('maps the codes that existed before the guard', () => {
    expect(describe_('DAILY_LIMIT_REACHED').title).toBe(labels.dailyLimitReached);
    expect(describe_('SENDER_DOMAIN_NOT_VERIFIED').title).toBe(labels.senderDomainNotVerified);
    expect(describe_('EMAIL_TOO_LARGE').title).toBe(labels.emailTooLarge);
  });

  it('lists the invalid addresses the backend found', () => {
    expect(describe_('INVALID_RECIPIENTS', { invalidFormat: ['nope'], unreachableDomains: ['gone.invalid'] }).title).toBe(
      'These recipient addresses cannot be used: nope, gone.invalid.',
    );
    expect(describe_('INVALID_RECIPIENTS').title).toBe(labels.invalidRecipients);
  });

  it('keeps the backend message for a code it does not know, then the call site fallback', () => {
    expect(describe_('SOMETHING_NEW', undefined, '  Something specific broke ').title).toBe('Something specific broke');
    expect(describe_(undefined)).toEqual({ title: FALLBACK, description: undefined, suggestWeldReach: false });
  });

  it('ignores details of the wrong shape', () => {
    const view = describe_('SENDING_LIMITED', 'oops');
    expect(view.title).toBe(labels.sendingLimited.generic);
    expect(describe_('SENDING_LIMITED', { window: 'week', limit: 'many', retryAfter: 5 }).title).toBe(
      labels.sendingLimited.generic,
    );
  });

  it('has a message for every guard code', () => {
    for (const code of OUTBOUND_DENIAL_CODES) {
      const view = describe_(code, {});
      expect(view.title, code).not.toBe(FALLBACK);
      expect(view.title.length, code).toBeGreaterThan(0);
    }
  });
});

describe('Dutch labels', () => {
  it('have the same keys as English', () => {
    const keysOf = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([k, v]) => keysOf(v, `${prefix}${k}.`))
        : [prefix];
    expect(keysOf(nl.mail.sending)).toEqual(keysOf(en.mail.sending));
    expect(keysOf(nl.settings.weldmail.limits)).toEqual(keysOf(en.settings.weldmail.limits));
  });

  it('render with the Dutch relative time', () => {
    const view = describeSendError(
      { errorCode: 'SENDING_LIMITED', errorDetails: { window: 'hour', limit: 30, retryAfter: inMinutes(25) } },
      nl.mail.sending.errors,
      { locale: 'nl', fallback: FALLBACK, now: NOW },
    );
    expect(view.description).toBe('Limiet: 30 ontvangers per uur. Je kunt weer verzenden over 25 minuten.');
  });
});
