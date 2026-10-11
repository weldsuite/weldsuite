/**
 * Reseller territory in onboarding: create-workspace answers 409
 * PARTNER_TERRITORY (and creates nothing) for a country a reseller serves, and
 * POST /partner-request files a request with that country's reseller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';

vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => ({ master: true }) };
});
vi.mock('../../services/partner/managed', async (orig) => {
  const actual = await orig<typeof import('../../services/partner/managed')>();
  return { ...actual, territoryPartnerInfo: vi.fn() };
});
vi.mock('@weldsuite/core-domain/partners', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/core-domain/partners')>();
  return { ...actual, createWorkspaceRequest: vi.fn(), partnerAdminEmails: vi.fn() };
});
vi.mock('../../services/partner/notify', () => ({ sendWorkspaceRequestEmail: vi.fn(async () => undefined) }));

import * as domain from '@weldsuite/core-domain/partners';
import { territoryPartnerInfo } from '../../services/partner/managed';
import { sendWorkspaceRequestEmail } from '../../services/partner/notify';
import { onboardingRoutes } from './index';
import type { Env } from '../../types';

const PARTNER = { id: 'ptr_1', name: 'Acme Reseller', logoUrl: null, websiteUrl: 'https://acme.test', supportEmail: 'help@acme.test', supportUrl: null };

const onboard = vi.fn();
const originalFetch = globalThis.fetch;

function app() {
  return createTestApp('/api/onboarding', onboardingRoutes, {
    context: { userId: 'user_1', orgId: null },
    env: {
      DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db',
      WORKSPACE_WORKER: { onboard },
    } as Partial<Env>,
  });
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  // Only Brazil is served by a reseller.
  vi.mocked(territoryPartnerInfo).mockImplementation(async (_db, country) => (country === 'BR' ? PARTNER : null));
  onboard.mockResolvedValue({ success: true, workspaceId: 'ws_1', clerkOrgId: 'org_1', ready: true });
  // Clerk user lookup (fetchClerkUser).
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ first_name: 'Ana', last_name: 'Silva', email_addresses: [{ email_address: 'ana@customer.test' }], image_url: '' }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /create-workspace territory', () => {
  it('answers 409 PARTNER_TERRITORY and creates nothing for a served country', async () => {
    const res = await app().request('/api/onboarding/create-workspace', post({ name: 'Acme', country: 'br' }, { 'CF-IPCountry': 'BR' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'PARTNER_TERRITORY',
        message: 'WeldSuite in BR is provided by Acme Reseller.',
        details: { country: 'BR', partner: PARTNER },
      },
    });
    expect(onboard).not.toHaveBeenCalled();
  });

  it('decides by the request country when no body country is sent', async () => {
    const res = await app().request('/api/onboarding/create-workspace', post({ name: 'Acme' }, { 'CF-IPCountry': 'BR' }));
    expect(res.status).toBe(409);
    expect(onboard).not.toHaveBeenCalled();
  });

  it('is still blocked when the body says NL but the request comes from BR', async () => {
    const res = await app().request('/api/onboarding/create-workspace', post({ name: 'Acme', country: 'NL' }, { 'CF-IPCountry': 'BR' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'PARTNER_TERRITORY', details: { country: 'BR' } } });
    // The lookup only ever sees the network country.
    expect(territoryPartnerInfo).toHaveBeenCalledWith(expect.anything(), 'BR');
    expect(territoryPartnerInfo).not.toHaveBeenCalledWith(expect.anything(), 'NL');
    expect(onboard).not.toHaveBeenCalled();
  });

  it('does not let a served body country block a request from an open country', async () => {
    const res = await app().request('/api/onboarding/create-workspace', post({ name: 'Acme', country: 'BR' }, { 'CF-IPCountry': 'NL' }));
    expect(res.status).toBe(200);
    // The chosen country is still stored on the workspace.
    expect(onboard).toHaveBeenCalledWith(expect.objectContaining({ workspaceName: 'Acme', country: 'BR' }));
  });

  it('is not blocked when the request country is unknown', async () => {
    const res = await app().request('/api/onboarding/create-workspace', post({ name: 'Acme', country: 'BR' }));
    expect(res.status).toBe(200);
    expect(territoryPartnerInfo).toHaveBeenCalledWith(expect.anything(), null);
  });

  it('creates the workspace as before outside every territory', async () => {
    const res = await app().request('/api/onboarding/create-workspace', post({ name: 'Acme' }, { 'CF-IPCountry': 'DE' }));
    expect(res.status).toBe(200);
    expect(onboard).toHaveBeenCalledTimes(1);
    // No country was chosen, so none is stored.
    expect(onboard.mock.calls[0]![0].country).toBeUndefined();
  });
});

describe('first-workspace onboarding territory', () => {
  it('POST /workspace answers 409 and creates nothing for a served country', async () => {
    const res = await app().request('/api/onboarding/workspace', post({ name: 'Acme', country: 'BR' }, { 'CF-IPCountry': 'BR' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PARTNER_TERRITORY');
    expect(onboard).not.toHaveBeenCalled();
  });

  it('POST /workspace is still blocked when the body says NL but the request comes from BR', async () => {
    const res = await app().request('/api/onboarding/workspace', post({ name: 'Acme', country: 'NL' }, { 'CF-IPCountry': 'BR' }));
    expect(res.status).toBe(409);
    expect(onboard).not.toHaveBeenCalled();
  });

  it('POST /workspace creates the workspace outside every territory', async () => {
    const res = await app().request('/api/onboarding/workspace', post({ name: 'Acme', country: 'NL' }, { 'CF-IPCountry': 'NL' }));
    expect(res.status).toBe(200);
    expect(onboard).toHaveBeenCalledTimes(1);
  });

  it('POST /complete (no org yet) answers 409 and creates nothing for a served country', async () => {
    const res = await app().request(
      '/api/onboarding/complete',
      post({ organizationName: 'Acme' }, { 'CF-IPCountry': 'BR' }),
    );
    expect(res.status).toBe(409);
    expect(onboard).not.toHaveBeenCalled();
  });

  it('POST /complete fallback ignores a body country of NL on a BR request', async () => {
    const res = await app().request(
      '/api/onboarding/complete',
      post({ organizationName: 'Acme', country: 'NL' }, { 'CF-IPCountry': 'BR' }),
    );
    expect(res.status).toBe(409);
    expect(onboard).not.toHaveBeenCalled();
  });
});

describe('POST /partner-request', () => {
  const body = { companyName: 'Customer BV', country: 'br', selectedApps: ['welddesk'], message: 'Call me' };

  it('files the request with the country’s reseller and emails its owners and admins', async () => {
    vi.mocked(domain.createWorkspaceRequest).mockResolvedValue({ id: 'pwr_1' });
    vi.mocked(domain.partnerAdminEmails).mockResolvedValue(['owner@acme.test']);

    const res = await app().request('/api/onboarding/partner-request', post(body, { 'CF-IPCountry': 'BR' }));

    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ id: 'pwr_1' });
    expect(domain.createWorkspaceRequest).toHaveBeenCalledWith(
      { master: true },
      {
        partnerId: 'ptr_1',
        requesterUserId: 'user_1',
        requesterEmail: 'ana@customer.test',
        requesterName: 'Ana Silva',
        companyName: 'Customer BV',
        countryCode: 'BR',
        selectedApps: ['welddesk'],
        message: 'Call me',
      },
    );
    await vi.waitFor(() => expect(sendWorkspaceRequestEmail).toHaveBeenCalled());
    expect(sendWorkspaceRequestEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: ['owner@acme.test'], partnerName: 'Acme Reseller', companyName: 'Customer BV', countryCode: 'BR' }),
    );
  });

  it('404s when the country has no reseller', async () => {
    const res = await app().request('/api/onboarding/partner-request', post({ ...body, country: 'DE' }, { 'CF-IPCountry': 'DE' }));
    expect(res.status).toBe(404);
    expect(domain.createWorkspaceRequest).not.toHaveBeenCalled();
  });

  it('picks the reseller by the request country, not the body country', async () => {
    const res = await app().request('/api/onboarding/partner-request', post(body, { 'CF-IPCountry': 'NL' }));
    expect(res.status).toBe(404);
    expect(domain.createWorkspaceRequest).not.toHaveBeenCalled();
  });

  it('answers 429 past the daily request cap', async () => {
    vi.mocked(domain.createWorkspaceRequest).mockRejectedValue(new domain.PartnerPortalError('RATE_LIMITED', 'Too many'));
    const res = await app().request('/api/onboarding/partner-request', post(body, { 'CF-IPCountry': 'BR' }));
    expect(res.status).toBe(429);
    expect(sendWorkspaceRequestEmail).not.toHaveBeenCalled();
  });

  it('validates the body', async () => {
    const res = await app().request('/api/onboarding/partner-request', post({ country: 'BR' }));
    expect(res.status).toBe(400);
  });
});
