import { describe, it, expect, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';

vi.mock('@weldsuite/core-domain/partners', () => ({
  listTerritories: vi.fn(async () => [
    { country: 'BR', partner: { id: 'ptr_1', name: 'Acme', logoUrl: null, websiteUrl: 'https://acme.test', supportEmail: null, supportUrl: null } },
  ]),
}));

import { publicPartnerTerritoriesRoutes } from './index';

describe('GET /public/partner-territories', () => {
  it('lists country → partner public info, cacheable for 5 minutes, no auth needed', async () => {
    const { request } = createTestApp('/public/partner-territories', publicPartnerTerritoriesRoutes, {
      env: { DATABASE_URL_MASTER: 'postgres://u:p@ep-test.neon.tech/db' },
    });
    const res = await request('/public/partner-territories');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as { data: Array<{ country: string; partner: { name: string } }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ country: 'BR', partner: { name: 'Acme' } });
  });
});
