import {
  canUnsubscribe,
  findSenderSubscription,
  senderLabel,
  unsubscribeConfirmMessage,
  unsubscribeOutcome,
} from '../unsubscribe';
import type { TenantSubscription } from '@/services/mail-tenant';

function sub(overrides: Partial<TenantSubscription> = {}): TenantSubscription {
  return {
    id: 'msub_1',
    accountId: 'macc_1',
    senderEmail: 'news@shop.example',
    senderName: 'Shop',
    lastSubject: 'Deals',
    messageCount: 3,
    lastReceivedAt: '2026-11-20T00:00:00.000Z',
    status: 'active',
    unsubscribedAt: null,
    unsubscribeUrl: null,
    unsubscribeMailto: null,
    oneClick: false,
    ...overrides,
  };
}

describe('findSenderSubscription', () => {
  const list = [sub({ id: 'a' }), sub({ id: 'b', senderEmail: 'hi@other.example' })];

  it('matches the sender address case- and space-insensitively', () => {
    expect(findSenderSubscription(list, ' NEWS@shop.example ')?.id).toBe('a');
    expect(findSenderSubscription(list, 'hi@other.example')?.id).toBe('b');
  });

  it('finds nothing for an unknown or missing sender', () => {
    expect(findSenderSubscription(list, 'x@y.example')).toBeUndefined();
    expect(findSenderSubscription(list, undefined)).toBeUndefined();
    expect(findSenderSubscription(undefined, 'news@shop.example')).toBeUndefined();
  });
});

describe('canUnsubscribe', () => {
  it('needs a URL or a mailto', () => {
    expect(canUnsubscribe(sub({ unsubscribeUrl: 'https://shop.example/u' }))).toBe(true);
    expect(canUnsubscribe(sub({ unsubscribeMailto: 'mailto:u@shop.example' }))).toBe(true);
    expect(canUnsubscribe(sub())).toBe(false);
  });
});

describe('unsubscribeConfirmMessage', () => {
  it('says what will happen, by method', () => {
    expect(unsubscribeConfirmMessage(sub({ unsubscribeUrl: 'https://shop.example/u', oneClick: true }))).toBe(
      'WeldMail will ask Shop to stop sending email to this mailbox.',
    );
    expect(unsubscribeConfirmMessage(sub({ unsubscribeMailto: 'mailto:u@shop.example' }))).toBe(
      'WeldMail will send an unsubscribe request from this mailbox to Shop.',
    );
    expect(unsubscribeConfirmMessage(sub({ unsubscribeUrl: 'https://shop.example/u' }))).toBe(
      'The unsubscribe page of Shop opens in your browser. Finish the steps there.',
    );
  });

  it('uses the address when there is no sender name', () => {
    expect(senderLabel(sub({ senderName: null }))).toBe('news@shop.example');
  });
});

describe('unsubscribeOutcome', () => {
  it('reports one-click and mailto as done', () => {
    expect(unsubscribeOutcome('one_click', null, 'Shop')).toEqual({
      kind: 'success',
      message: 'Unsubscribed from Shop',
      openUrl: null,
    });
    expect(unsubscribeOutcome('mailto', null, 'Shop').message).toBe('Unsubscribe request sent to Shop');
  });

  it('hands back the page to open for a link', () => {
    expect(unsubscribeOutcome('link', 'https://shop.example/u', 'Shop')).toEqual({
      kind: 'info',
      message: 'Finish unsubscribing on the page of Shop',
      openUrl: 'https://shop.example/u',
    });
  });
});
