import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MailSubscription } from '@weldsuite/app-api-client';
import { useSenderUnsubscribe } from './use-sender-unsubscribe';

const state = vi.hoisted(() => ({
  subscription: null as MailSubscription | null,
  senderQuery: vi.fn(),
  mutateAsync: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useSenderMailSubscription: (accountId?: string, senderEmail?: string | null) => {
    state.senderQuery(accountId, senderEmail);
    return { data: state.subscription };
  },
  useUnsubscribeMailSubscription: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/i18n/provider')>('@weldsuite/i18n/provider');
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { ...actual, useI18n: () => ({ t: en }) };
});

vi.mock('sonner', () => ({ toast: state.toast }));

function sub(overrides: Partial<MailSubscription> = {}): MailSubscription {
  return {
    id: 'msub_1',
    accountId: 'macc_1',
    senderEmail: 'news@shop.example',
    senderName: 'Shop',
    senderDomain: 'shop.example',
    listId: null,
    unsubscribeUrl: 'https://shop.example/u/1',
    unsubscribeMailto: null,
    oneClick: true,
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

function render(subscription: MailSubscription | null) {
  state.subscription = subscription;
  return renderHook(() => useSenderUnsubscribe('macc_1', 'news@shop.example')).result.current;
}

beforeEach(() => {
  state.senderQuery.mockReset();
  state.mutateAsync.mockReset();
  state.toast.success.mockReset();
  state.toast.info.mockReset();
  state.toast.error.mockReset();
});

describe('useSenderUnsubscribe', () => {
  it('looks the sender up in the mailbox subscriptions', () => {
    render(null);
    expect(state.senderQuery).toHaveBeenCalledWith('macc_1', 'news@shop.example');
  });

  it('has nothing to do for ordinary mail', async () => {
    const result = render(null);
    expect(result.subscription).toBeNull();
    expect(result.canUnsubscribeInPlace).toBe(false);
    await result.unsubscribeInPlace();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it('unsubscribes in place only from an active sender with one-click or a mailto', () => {
    expect(render(sub()).canUnsubscribeInPlace).toBe(true);
    expect(render(sub({ oneClick: false, unsubscribeUrl: null, unsubscribeMailto: 'mailto:u@shop.example' })).canUnsubscribeInPlace).toBe(true);
    expect(render(sub({ oneClick: false })).canUnsubscribeInPlace).toBe(false);
    expect(render(sub({ status: 'unsubscribed' })).canUnsubscribeInPlace).toBe(false);
  });

  it('unsubscribes and reports it', async () => {
    state.mutateAsync.mockResolvedValue({ data: { subscription: sub({ status: 'unsubscribed' }), method: 'one_click', url: null } });
    await render(sub()).unsubscribeInPlace();
    expect(state.mutateAsync).toHaveBeenCalledWith('msub_1');
    expect(state.toast.success).toHaveBeenCalledWith('Unsubscribed from Shop');
  });

  it('reports a failed unsubscribe without throwing', async () => {
    state.mutateAsync.mockRejectedValue(new Error('bad gateway'));
    await expect(render(sub()).unsubscribeInPlace()).resolves.toBeUndefined();
    expect(state.toast.error).toHaveBeenCalledWith('Could not unsubscribe from Shop');
  });
});
