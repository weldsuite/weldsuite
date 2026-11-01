/**
 * Every /api/carriers route on pglite (the shared suite in
 * ../../testing/shipping-crud-suite.ts). Runs against Rust in conformance mode.
 */

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@weldsuite/worker-kit/db';
import { describeShippingCrud } from '../../testing/shipping-crud-suite';
import { carriersRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const crud = describeShippingCrud({
  base: '/api/carriers',
  routes: carriersRoutes,
  table: schema.carriers,
  gates: { read: 'carriers:read', create: 'carriers:create', update: 'carriers:update', delete: 'carriers:delete' },
  resource: 'Carrier',
  noun: { one: 'carrier', many: 'carriers' },
  idPrefix: 'crr',
  entityType: 'parcel_carrier',
  seed: (n) => ({ name: `Carrier ${n}`, code: `C${n}` }),
  detail: {
    name: 'Carrier 1',
    code: 'C1',
    logo: null,
    website: null,
    isActive: true,
    isDefault: false,
    integrationType: 'manual',
    apiCredentials: null,
    supportedServices: null,
    trackingUrlTemplate: null,
    description: null,
  },
  valid: {
    body: {
      name: 'PostNL',
      code: 'POSTNL',
      trackingUrlTemplate: 'https://postnl.example/track/{tracking}',
      isActive: false,
      config: { sandbox: true },
      metadata: { source: 'test' },
      website: 'https://postnl.example',
      supportedServices: ['standard', 'mailbox'],
      description: 'Dutch post',
    },
    stored: {
      name: 'PostNL',
      code: 'POSTNL',
      trackingUrlTemplate: 'https://postnl.example/track/{tracking}',
      isActive: false,
      isDefault: false,
      integrationType: 'manual',
      website: 'https://postnl.example',
      supportedServices: ['standard', 'mailbox'],
      description: 'Dutch post',
    },
    event: { name: 'PostNL', code: 'POSTNL' },
  },
  // The schema allows any string; the column holds 20 characters.
  unstorable: [{ name: 'Too long', code: 'TL', integrationType: 'x'.repeat(21) }],
  invalid: [
    {},
    { name: 'No code' },
    { name: '', code: 'X' },
    { name: 'x'.repeat(256), code: 'X' },
    { name: 'X', code: '' },
    { name: 'X', code: 'x'.repeat(51) },
    { name: 'X', code: 'X', isActive: 'yes' },
    { name: 'X', code: 'X', trackingUrlTemplate: 'x'.repeat(501) },
  ],
  emptyBodyStatus: 400,
  patch: {
    body: { name: 'Renamed carrier', isActive: false, supportEmail: 'ops@example.test' },
    stored: { name: 'Renamed carrier', code: 'C6', isActive: false, supportEmail: 'ops@example.test' },
    event: { name: 'Renamed carrier', code: 'C6' },
  },
  invalidPatch: { code: '' },
  filters: [
    { query: 'search=Needle', match: { name: 'Needle Express' } },
    { query: 'search=NDL', match: { code: 'NDL' } },
  ],
  // LIKE, not ILIKE.
  misses: ['search=needle', 'search=ndl'],
  goneCursorCount: 'drops-last-condition',
});

describe('/api/carriers · carrier specifics', () => {
  it('PATCH /:id publishes the code it sets, the stored name when it sets none', async () => {
    crud.clearEvents();
    const id = crud.seedId(1);
    const res = await crud.app('carriers:update').request(`/api/carriers/${id}`, crud.json({ code: 'NEW1' }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(await crud.detailOf(id)).toMatchObject({ name: 'Carrier 1', code: 'NEW1' });
    expect(crud.published()).toEqual([
      { entityType: 'parcel_carrier', action: 'updated', entityId: id, data: { id, name: 'Carrier 1', code: 'NEW1' } },
    ]);
  });
});
