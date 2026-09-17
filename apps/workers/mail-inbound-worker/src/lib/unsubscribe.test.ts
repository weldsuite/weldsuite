/**
 * Unit tests for the shared unsubscribe mechanism picker (used by app-api
 * and personal-api). Network and mail sending are injected.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  UnsubscribeError,
  performUnsubscribe,
  type UnsubscribeDeps,
  type UnsubscribeTargets,
} from '@weldsuite/email/list-unsubscribe';

function deps(overrides: Partial<UnsubscribeDeps> = {}) {
  return {
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    sendMail: vi.fn(async () => {}),
    ...overrides,
  } satisfies UnsubscribeDeps;
}

function targets(overrides: Partial<UnsubscribeTargets> = {}): UnsubscribeTargets {
  return { unsubscribeUrl: null, unsubscribeMailto: null, oneClick: false, ...overrides };
}

describe('performUnsubscribe', () => {
  it('uses RFC 8058 one-click POST when offered', async () => {
    const d = deps();
    const outcome = await performUnsubscribe(
      targets({ unsubscribeUrl: 'https://news.shop.com/u/1', oneClick: true, unsubscribeMailto: 'mailto:u@shop.com' }),
      d,
    );
    expect(outcome).toEqual({ method: 'one_click', url: null });
    expect(d.fetch).toHaveBeenCalledWith(
      'https://news.shop.com/u/1',
      expect.objectContaining({ method: 'POST', body: 'List-Unsubscribe=One-Click' }),
    );
    expect(d.sendMail).not.toHaveBeenCalled();
  });

  it('falls back to mailto when the one-click POST fails', async () => {
    const d = deps({ fetch: vi.fn(async () => new Response(null, { status: 500 })) });
    const outcome = await performUnsubscribe(
      targets({
        unsubscribeUrl: 'https://news.shop.com/u/1',
        oneClick: true,
        unsubscribeMailto: 'mailto:leave@shop.com?subject=Remove%20me',
      }),
      d,
    );
    expect(outcome.method).toBe('mailto');
    expect(d.sendMail).toHaveBeenCalledWith({ to: 'leave@shop.com', subject: 'Remove me', body: 'unsubscribe' });
  });

  it('returns the link for the browser when there is no one-click or mailto', async () => {
    const d = deps();
    const outcome = await performUnsubscribe(targets({ unsubscribeUrl: 'https://shop.com/prefs' }), d);
    expect(outcome).toEqual({ method: 'link', url: 'https://shop.com/prefs' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('never POSTs to an unsafe URL', async () => {
    const d = deps();
    await expect(
      performUnsubscribe(targets({ unsubscribeUrl: 'https://127.0.0.1/u', oneClick: true }), d),
    ).rejects.toMatchObject({ code: 'NO_UNSUBSCRIBE_METHOD' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('reports a failure when the only method errors', async () => {
    const d = deps({ sendMail: vi.fn(async () => { throw new Error('send binding missing'); }) });
    const err = await performUnsubscribe(targets({ unsubscribeMailto: 'mailto:leave@shop.com' }), d).catch((e) => e);
    expect(err).toBeInstanceOf(UnsubscribeError);
    expect(err.code).toBe('UNSUBSCRIBE_FAILED');
  });
});
