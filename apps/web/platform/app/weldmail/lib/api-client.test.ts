/**
 * Regression cover for the WeldMail scheduled-send URL.
 *
 * Both compose surfaces used to POST a hand-rolled `/mail/scheduled`, which
 * resolves to `/api/mail/scheduled`. app-api mounts the routes at
 * `/api/mail-scheduled` and has no `/api/mail` mount at all, so every schedule
 * from the web 404'd and surfaced as "Failed to schedule email". Nothing
 * covered this path, which is why it shipped. These tests pin the wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mailApi } from './api-client';

const BASE = 'http://localhost:8789/api';

function mockFetch(body: unknown = { data: { messageId: 'm1' } }, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof mockFetch>) {
  const [url, init] = fn.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

const baseArgs = {
  accountId: 'acc_1',
  to: ['someone@example.com'],
  scheduledFor: new Date('2030-01-02T03:04:05.000Z'),
};

describe('mailApi.scheduled', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the hyphenated /mail-scheduled mount, never /mail/scheduled', async () => {
    const fetchMock = mockFetch();
    await mailApi.scheduled.schedule(baseArgs);

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-scheduled`);
    // The exact shape of the original bug — guard it explicitly.
    expect(url).not.toContain('/api/mail/scheduled');
    expect(init.method).toBe('POST');
  });

  it('serialises scheduledFor as an ISO string (route expects z.string().datetime())', async () => {
    const fetchMock = mockFetch();
    await mailApi.scheduled.schedule(baseArgs);

    expect(lastCall(fetchMock).body.scheduledFor).toBe('2030-01-02T03:04:05.000Z');
  });

  it('passes freshly-uploaded attachments through unchanged', async () => {
    const fetchMock = mockFetch();
    const attachments = [
      { filename: 'a.pdf', contentType: 'application/pdf', size: 12, fileKey: 'k/1' },
    ];
    await mailApi.scheduled.schedule({ ...baseArgs, attachments });

    expect(lastCall(fetchMock).body.attachments).toEqual(attachments);
  });

  it('reports failure via the ApiResponse envelope rather than throwing', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Message not found' } }, 404);

    const result = await mailApi.scheduled.schedule(baseArgs);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe('Message not found');
  });

  it('targets the hyphenated mount for cancel / send-now / reschedule too', async () => {
    const fetchMock = mockFetch();

    await mailApi.scheduled.cancel('msg_1');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-scheduled/msg_1/cancel`);

    await mailApi.scheduled.sendNow('msg_1');
    expect(lastCall(fetchMock).url).toBe(`${BASE}/mail-scheduled/msg_1/send-now`);

    await mailApi.scheduled.reschedule('msg_1', new Date('2030-05-06T07:08:09.000Z'));
    const { url, body } = lastCall(fetchMock);
    expect(url).toBe(`${BASE}/mail-scheduled/msg_1/reschedule`);
    expect(body.scheduledFor).toBe('2030-05-06T07:08:09.000Z');
  });
});
