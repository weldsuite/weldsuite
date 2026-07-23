import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleSendSms } from './sms';
import { makeActionContext } from '../../test/ctx';

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init);
    }),
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('send_sms (Telnyx)', () => {
  const env = { TELNYX_API_KEY: 'KEY123' };

  it('posts to Telnyx with the bearer key and returns queued', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ data: { id: 'msg_1' } }), { status: 200 }));
    const res = (await handleSendSms({ to: '+3212345678', body: 'hi' }, makeActionContext({ env }))) as {
      sent: boolean;
      id?: string;
    };
    expect(res.sent).toBe(true);
    expect(res.id).toBe('msg_1');
    expect(calls[0].url).toContain('api.telnyx.com');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer KEY123');
  });

  it('throws without a phone number or body', async () => {
    await expect(handleSendSms({ body: 'x' }, makeActionContext({ env }))).rejects.toThrow(/phone/i);
    await expect(handleSendSms({ to: '+321' }, makeActionContext({ env }))).rejects.toThrow(/message/i);
  });

  it('throws when TELNYX_API_KEY is missing', async () => {
    await expect(handleSendSms({ to: '+321', body: 'hi' }, makeActionContext({ env: {} }))).rejects.toThrow(
      /TELNYX/i,
    );
  });
});
