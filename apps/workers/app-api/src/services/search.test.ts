/**
 * Result URLs for CRM search hits.
 *
 * The platform has no detail routes for CRM records. Companies and people open
 * as object panels on their list page (`?stack=`); leads and opportunities open
 * as an entity sheet over any page (`?entity=`). A URL to a removed detail
 * route lands on a 404, so these are pinned here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { SearchEntityType } from '@weldsuite/app-api-client/schemas/search';

import { buildResultUrl, searchContacts, searchCustomers } from './search';

describe('buildResultUrl · CRM', () => {
  it.each<[SearchEntityType, string, string]>([
    ['customer', 'cmp_acme', '/weldcrm/companies?stack=company:cmp_acme'],
    ['contact', 'per_jane', '/weldcrm/people?stack=person:per_jane'],
    ['lead', 'lead_1', '/weldcrm?entity=lead:lead_1'],
    ['opportunity', 'opp_1', '/weldcrm?entity=opportunity:opp_1'],
  ])('links a %s to its panel', (type, id, url) => {
    expect(buildResultUrl(type, id)).toBe(url);
  });

  it('never points at a removed /weldcrm detail route', () => {
    for (const type of ['customer', 'contact', 'lead', 'opportunity'] as const) {
      expect(buildResultUrl(type, 'x_1')).not.toMatch(
        /\/weldcrm\/(customers|contacts|leads|opportunities)\//,
      );
    }
  });
});

describe('searchContacts / searchCustomers', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    const now = new Date();
    await db.insert(schema.companies).values({
      id: 'cmp_acme',
      name: 'Acme Industries',
      displayName: 'Acme Industries',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.companies.$inferInsert);
    await db.insert(schema.people).values({
      id: 'per_jane',
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      displayName: 'Jane Doe',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof schema.people.$inferInsert);
  }, 60_000);

  it('opens a company hit in the company panel', async () => {
    const group = await searchCustomers(db, 'ws_test', 'acme', 10);
    expect(group.items).toEqual([
      expect.objectContaining({
        id: 'cmp_acme',
        title: 'Acme Industries',
        url: '/weldcrm/companies?stack=company:cmp_acme',
      }),
    ]);
  });

  it('opens a person hit in the person panel', async () => {
    const group = await searchContacts(db, 'ws_test', 'jane', 10);
    expect(group.items).toEqual([
      expect.objectContaining({
        id: 'per_jane',
        title: 'Jane Doe',
        url: '/weldcrm/people?stack=person:per_jane',
      }),
    ]);
  });
});
