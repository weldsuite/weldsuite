/**
 * The staff notification for a new access request: what it sends, to whom, and
 * that it never throws (it runs in waitUntil, after the response).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAccessRequestInput } from '@weldsuite/app-api-client/schemas/reach';
import { WELDREACH_TERMS, WELDREACH_TERMS_VERSION } from '@weldsuite/app-api-client/schemas/reach';
import type { Env } from '../types';

vi.mock('@weldsuite/emails', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/emails')>();
  return { ...actual, sendSystemEmail: vi.fn(async () => ({ messageId: 'm_1', transport: 'memory' })) };
});
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: vi.fn() }));

import { sendSystemEmail } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { DEFAULT_ADMIN_CONSOLE_URL, accessRequestsUrl, notifyAccessRequested } from './app-access-notify';

const mockedSend = vi.mocked(sendSystemEmail);
const mockedTransport = vi.mocked(workerTransport);
const transport = { name: 'test', send: vi.fn() };

const input: AppAccessRequestInput = {
  companyName: 'Acme B.V.',
  website: 'https://acme.example',
  contactName: 'Lisa de Vries',
  contactEmail: 'lisa@acme.example',
  useCase: 'We email past customers about a new service tier.',
  expectedDailySends: 200,
  targetCountries: ['BE', 'NL'],
  listSource: 'own_customers',
  termsVersion: WELDREACH_TERMS_VERSION,
  termsAccepted: [...WELDREACH_TERMS],
};

const params = { appCode: 'weldreach', workspaceId: 'ws_1', workspaceName: 'Acme Studio', input };
const env = (extra: Partial<Env> = {}) => ({ ACCESS_REQUEST_NOTIFY_EMAIL: 'gert@weldsuite.org', ...extra }) as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mockedTransport.mockReturnValue(transport);
});

describe('notifyAccessRequested', () => {
  it('emails the configured address, Reply-To the requester, with a link to the admin console', async () => {
    await notifyAccessRequested(env(), params);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [usedTransport, options] = mockedSend.mock.calls[0]!;
    expect(usedTransport).toBe(transport);
    expect(options).toMatchObject({
      template: 'internal.app-access-requested',
      to: 'gert@weldsuite.org',
      replyTo: 'lisa@acme.example',
      locale: 'en',
      props: {
        appName: 'WeldReach',
        workspaceName: 'Acme Studio',
        workspaceId: 'ws_1',
        companyName: 'Acme B.V.',
        targetCountries: ['BE', 'NL'],
        listSource: 'own_customers',
        termsVersion: WELDREACH_TERMS_VERSION,
        reviewUrl: `${DEFAULT_ADMIN_CONSOLE_URL}/access-requests`,
      },
    });
  });

  it('uses ADMIN_CONSOLE_URL for the link when set', async () => {
    await notifyAccessRequested(env({ ADMIN_CONSOLE_URL: 'https://admin-test.example.org/' }), params);
    expect(mockedSend.mock.calls[0]![1].props).toMatchObject({
      reviewUrl: 'https://admin-test.example.org/access-requests',
    });
  });

  it('shows an unknown app by its code', async () => {
    await notifyAccessRequested(env(), { ...params, appCode: 'weldfoo' });
    expect(mockedSend.mock.calls[0]![1].props).toMatchObject({ appName: 'weldfoo' });
  });

  it('skips quietly when no address is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await notifyAccessRequested(env({ ACCESS_REQUEST_NOTIFY_EMAIL: '  ' }), params);

    expect(mockedSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips quietly when the worker has no email transport', async () => {
    mockedTransport.mockReturnValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await notifyAccessRequested(env(), params);

    expect(mockedSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never throws when the send fails', async () => {
    mockedSend.mockRejectedValueOnce(new Error('smtp down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(notifyAccessRequested(env(), params)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('accessRequestsUrl', () => {
  it('defaults to the production admin console', () => {
    expect(accessRequestsUrl({})).toBe('https://admin.weldsuite.org/access-requests');
  });
});
