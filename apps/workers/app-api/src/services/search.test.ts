/**
 * Result URLs for search hits.
 *
 * The platform has no detail routes for CRM records. Companies and people open
 * as object panels on their list page (`?stack=`); leads and opportunities open
 * as an entity sheet over any page (`?entity=`). Tickets, products and orders
 * have no detail route either. A URL to a missing route lands on a 404 or a
 * catch-all redirect, so these are pinned here, and every type is checked
 * against the platform's route tree.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
} from '@weldsuite/app-api-client/schemas/search';

import { isPlatformRoute } from '../test/platform-routes';
import {
  buildResultUrl,
  runSearch,
  searchContacts,
  searchCustomers,
  type RunSearchParams,
} from './search';

const COMMERCE_PRODUCT = '/weldcommerce/products?stack=product:prd_1';
const STASH_PRODUCT = '/weldstash/products?stack=product:prd_1';

describe('buildResultUrl · platform routes', () => {
  it.each(SEARCH_ENTITY_TYPES)('links a %s to a route the platform has', (type) => {
    expect(isPlatformRoute(buildResultUrl(type, 'x_1'))).toBe(true);
  });

  it('rejects the stale detail routes it used to return', () => {
    for (const url of [
      '/welddesk/tickets/x_1',
      '/welddesk/articles/x_1',
      '/weldstash/products/x_1',
      '/weldstash/orders/x_1',
      '/weldflow/projects/x_1',
      '/weldflow/tasks/x_1',
    ]) {
      expect(isPlatformRoute(url), url).toBe(false);
    }
  });
});

describe('buildResultUrl · records outside the CRM', () => {
  it.each<[SearchEntityType, string, string]>([
    // No ticket route: the entity sheet opens over the WeldDesk inbox.
    ['ticket', 'tkt_1', '/welddesk/inbox?entity=ticket:tkt_1'],
    ['article', 'art_1', '/welddesk/help-center/articles/art_1'],
    ['knowledge_page', 'kp_1', '/weldknow/page/kp_1'],
    // Object panels on the WeldCommerce lists.
    ['product', 'prd_1', '/weldcommerce/products?stack=product:prd_1'],
    ['order', 'ord_1', '/weldcommerce/orders?stack=order:ord_1'],
    ['invoice', 'inv_1', '/weldbooks/invoices/inv_1'],
    ['bill', 'bill_1', '/weldbooks/bills/bill_1'],
    ['project', 'prj_1', '/weldflow/project/prj_1'],
    ['task', 'tsk_1', '/weldflow/task/tsk_1'],
    ['domain', 'dom_1', '/weldhost/domains/dom_1'],
  ])('links a %s to where the platform opens it', (type, id, url) => {
    expect(buildResultUrl(type, id)).toBe(url);
  });
});

// WeldCommerce and WeldStash list the same products; each module's layout
// shows "not installed" to a member who can't open it.
describe('buildResultUrl · product destination', () => {
  it.each<[string, string[] | undefined, string]>([
    ['apps unknown', undefined, COMMERCE_PRODUCT],
    ['both apps', ['weldcommerce', 'weldstash'], COMMERCE_PRODUCT],
    ['WeldCommerce only', ['weldcommerce'], COMMERCE_PRODUCT],
    ['WeldStash only', ['weldstash'], STASH_PRODUCT],
    ['neither app', ['weldcrm'], COMMERCE_PRODUCT],
  ])('%s', (_label, apps, url) => {
    expect(buildResultUrl('product', 'prd_1', apps && new Set(apps))).toBe(url);
  });

  it('links WeldStash products to a route the platform has', () => {
    expect(isPlatformRoute(STASH_PRODUCT)).toBe(true);
  });
});

describe('runSearch · product links', () => {
  let db: Database;

  function search(q: string, memberApps: RunSearchParams['memberApps']) {
    return runSearch(db, 'ws_test', {
      q,
      types: ['product'],
      limit: 5,
      perms: { hasAny: () => true },
      memberApps,
    });
  }

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.products).values({ id: 'prd_1', name: 'Hex bolt', slug: 'hex-bolt' });
  }, 60_000);

  it('links into WeldStash for a member without WeldCommerce', async () => {
    const { groups } = await search('bolt', async () => new Set(['weldstash']));
    expect(groups[0]!.items).toEqual([expect.objectContaining({ id: 'prd_1', url: STASH_PRODUCT })]);
  });

  it('keeps WeldCommerce links for a member who has it', async () => {
    const { groups } = await search('bolt', async () => new Set(['weldcommerce', 'weldstash']));
    expect(groups[0]!.items).toEqual([expect.objectContaining({ id: 'prd_1', url: COMMERCE_PRODUCT })]);
  });

  it('skips the app lookup when no product matches', async () => {
    const memberApps = vi.fn(async () => new Set(['weldstash']));
    const { groups } = await search('no such product', memberApps);
    expect(groups[0]!.items).toEqual([]);
    expect(memberApps).not.toHaveBeenCalled();
  });

  it('keeps WeldCommerce links when the app lookup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { groups } = await search('bolt', () => Promise.reject(new Error('db down')));
    expect(groups[0]!.items).toEqual([expect.objectContaining({ id: 'prd_1', url: COMMERCE_PRODUCT })]);
    consoleError.mockRestore();
  });
});

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
