import { describe, it, expect } from 'vitest';
import type { MailSubscription } from '@weldsuite/app-api-client';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import {
  canUnsubscribe,
  confirmDescriptionFor,
  findSenderSubscription,
  isLinkOnly,
  senderLabel,
  unsubscribeNotice,
  unsubscribesInPlace,
  type SubscriptionLabels,
} from './unsubscribe';

const labels: SubscriptionLabels = en.mail.subscriptions;

function sub(overrides: Partial<MailSubscription> = {}): MailSubscription {
  return {
    id: 'msub_1',
    accountId: 'macc_1',
    senderEmail: 'news@shop.example',
    senderName: 'Shop',
    senderDomain: 'shop.example',
    listId: null,
    unsubscribeUrl: null,
    unsubscribeMailto: null,
    oneClick: false,
    messageCount: 3,
    lastSubject: 'Deals',
    firstReceivedAt: '2026-11-01T00:00:00.000Z',
    lastReceivedAt: '2026-11-20T00:00:00.000Z',
    status: 'active',
    unsubscribeMethod: null,
    unsubscribedAt: null,
    unsubscribedBy: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

const oneClick = sub({ unsubscribeUrl: 'https://shop.example/u/1', oneClick: true });
const mailto = sub({ unsubscribeMailto: 'mailto:unsub@shop.example' });
const linkOnly = sub({ unsubscribeUrl: 'https://shop.example/u/1' });
const none = sub();

describe('findSenderSubscription', () => {
  const list = [sub({ id: 'a', senderEmail: 'news@shop.example' }), sub({ id: 'b', senderEmail: 'hi@other.example' })];

  it('matches the sender address case- and space-insensitively', () => {
    expect(findSenderSubscription(list, '  News@Shop.Example ')?.id).toBe('a');
    expect(findSenderSubscription(list, 'hi@other.example')?.id).toBe('b');
  });

  it('finds nothing for an unknown, empty or missing sender, or no list', () => {
    expect(findSenderSubscription(list, 'someone@else.example')).toBeUndefined();
    expect(findSenderSubscription(list, '')).toBeUndefined();
    expect(findSenderSubscription(list, null)).toBeUndefined();
    expect(findSenderSubscription(undefined, 'news@shop.example')).toBeUndefined();
  });
});

describe('unsubscribe methods', () => {
  it('can unsubscribe with a URL or a mailto, not without either', () => {
    expect(canUnsubscribe(oneClick)).toBe(true);
    expect(canUnsubscribe(mailto)).toBe(true);
    expect(canUnsubscribe(linkOnly)).toBe(true);
    expect(canUnsubscribe(none)).toBe(false);
  });

  it('unsubscribes in place only by one-click or mailto', () => {
    expect(unsubscribesInPlace(oneClick)).toBe(true);
    expect(unsubscribesInPlace(mailto)).toBe(true);
    expect(unsubscribesInPlace(linkOnly)).toBe(false);
    expect(unsubscribesInPlace(none)).toBe(false);
    // The one-click flag without a URL is nothing to POST to.
    expect(unsubscribesInPlace(sub({ oneClick: true }))).toBe(false);
  });

  it('is link-only for a plain https link with no one-click and no mailto', () => {
    expect(isLinkOnly(linkOnly)).toBe(true);
    expect(isLinkOnly(oneClick)).toBe(false);
    expect(isLinkOnly(sub({ unsubscribeUrl: 'https://shop.example/u/1', unsubscribeMailto: 'mailto:u@shop.example' }))).toBe(false);
  });
});

describe('confirmDescriptionFor', () => {
  it('says what will happen, by method', () => {
    expect(confirmDescriptionFor(labels, oneClick)).toBe('WeldMail will ask Shop to stop sending email to this mailbox.');
    expect(confirmDescriptionFor(labels, mailto)).toBe('WeldMail will send an unsubscribe request from this mailbox to Shop.');
    expect(confirmDescriptionFor(labels, linkOnly)).toBe(
      'The unsubscribe page of Shop opens in a new tab. Finish the steps there.',
    );
  });

  it('falls back to the address when the sender has no name', () => {
    expect(senderLabel(sub({ senderName: null }))).toBe('news@shop.example');
    expect(confirmDescriptionFor(labels, { ...mailto, senderName: null })).toContain('news@shop.example');
  });

  it('is translated', () => {
    expect(confirmDescriptionFor(nl.mail.subscriptions, oneClick)).not.toBe(confirmDescriptionFor(labels, oneClick));
    expect(confirmDescriptionFor(nl.mail.subscriptions, oneClick)).toContain('Shop');
  });
});

describe('unsubscribeNotice', () => {
  it('reports one-click and mailto as done', () => {
    expect(unsubscribeNotice(labels, oneClick, { method: 'one_click', url: null })).toEqual({
      kind: 'success',
      message: 'Unsubscribed from Shop',
      openUrl: null,
    });
    expect(unsubscribeNotice(labels, mailto, { method: 'mailto', url: null })).toEqual({
      kind: 'success',
      message: 'Unsubscribe request sent to Shop',
      openUrl: null,
    });
  });

  it('offers the page when one-click failed and there was no mailto', () => {
    expect(unsubscribeNotice(labels, oneClick, { method: 'link', url: 'https://shop.example/u/1' })).toEqual({
      kind: 'info',
      message: 'Finish unsubscribing on the page of Shop',
      openUrl: 'https://shop.example/u/1',
    });
  });

  it('does not offer the page again for a link-only sender (it opened in the click)', () => {
    expect(unsubscribeNotice(labels, linkOnly, { method: 'link', url: 'https://shop.example/u/1' }).openUrl).toBeNull();
  });
});

describe('translations', () => {
  it('fills the scan toast placeholders the page passes', () => {
    for (const t of [en, nl]) {
      expect(t.mail.subscriptions.scanComplete).toContain('{subscriptions}');
      expect(t.mail.subscriptions.scanComplete).toContain('{scanned}');
    }
  });

  it('has the new labels in en and nl', () => {
    for (const t of [en, nl]) {
      expect(t.mail.subscriptions.unsubscribeFrom).toContain('{sender}');
      expect(t.mail.messageDetail.reportSpamAndUnsubscribe).toBeTruthy();
    }
  });
});
