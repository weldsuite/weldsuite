import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspaces, plans, users } from '@weldsuite/db/schema/master';
import { resolveOwnerEmail, setupWorkspaceBilling } from './provisioning';

/**
 * Minimal stand-in for the Drizzle master DB. Only the chains
 * `setupWorkspaceBilling` / `resolveOwnerEmail` actually use are modelled:
 * `select().from(t).where()[.limit()]` and `update(t).set().where()`.
 * Rows are keyed by the real table object, so a query against the wrong table
 * comes back empty rather than silently matching.
 */
function createFakeMasterDb(rows: {
  workspaces?: Record<string, unknown>[];
  plans?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
}) {
  const rowsFor = (table: unknown): Record<string, unknown>[] => {
    if (table === workspaces) return rows.workspaces ?? [];
    if (table === plans) return rows.plans ?? [];
    if (table === users) return rows.users ?? [];
    return [];
  };

  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          // Awaitable directly, and `.limit()` chainable — both shapes are used.
          const result = Promise.resolve(rowsFor(table)) as Promise<Record<string, unknown>[]> & {
            limit: (n: number) => Promise<Record<string, unknown>[]>;
          };
          result.limit = () => Promise.resolve(rowsFor(table));
          return result;
        },
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  };
}

describe('resolveOwnerEmail', () => {
  it('prefers the email carried in the provisioning payload', async () => {
    const masterDb = createFakeMasterDb({ users: [{ email: 'stale@example.com' }] });

    const email = await resolveOwnerEmail(masterDb, {
      userId: 'user_1',
      email: 'owner@example.com',
    });

    expect(email).toBe('owner@example.com');
  });

  it('falls back to the master users row when the payload has no email', async () => {
    const masterDb = createFakeMasterDb({ users: [{ email: 'creator@example.com' }] });

    // The Clerk organization.created webhook can build an initial member from
    // just a userId — this is that path.
    const email = await resolveOwnerEmail(masterDb, { userId: 'user_1' });

    expect(email).toBe('creator@example.com');
  });

  it('returns undefined when the user row does not exist', async () => {
    const masterDb = createFakeMasterDb({ users: [] });

    expect(await resolveOwnerEmail(masterDb, { userId: 'user_missing' })).toBeUndefined();
  });

  it('returns undefined when there is no initial member at all', async () => {
    const masterDb = createFakeMasterDb({});

    expect(await resolveOwnerEmail(masterDb, undefined)).toBeUndefined();
    expect(await resolveOwnerEmail(masterDb, {})).toBeUndefined();
  });
});

describe('setupWorkspaceBilling — Stripe customer email', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_123' } as never;

  /** Bodies posted to Stripe, in call order. */
  let posted: { url: string; body: URLSearchParams }[];

  beforeEach(() => {
    posted = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: URLSearchParams }) => {
        posted.push({ url, body: init.body });
        const payload = url.includes('/customers')
          ? { id: 'cus_test' }
          : { id: 'sub_test', status: 'trialing' };
        return { ok: true, json: async () => payload, text: async () => '' };
      }),
    );
    // The function logs progress; keep the test output readable.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A workspace with no billing yet, plus the Business plan to trial on. */
  const freshWorkspaceDb = () =>
    createFakeMasterDb({
      workspaces: [{ stripeCustomerId: null, stripeSubscriptionId: null }],
      plans: [{ id: 'plan_business', stripePriceIdMonthly: 'price_123' }],
    });

  const customerBody = () => {
    const call = posted.find((p) => p.url.includes('/v1/customers'));
    expect(call, 'expected a Stripe customer creation call').toBeDefined();
    return call!.body;
  };

  it('sends the email when one was resolved', async () => {
    const result = await setupWorkspaceBilling(
      env,
      freshWorkspaceDb(),
      'ws_1',
      'Acme',
      'org_1',
      'owner@example.com',
    );

    expect(customerBody().get('email')).toBe('owner@example.com');
    expect(result.customerId).toBe('cus_test');
  });

  it('omits the email entirely when none could be resolved', async () => {
    await setupWorkspaceBilling(env, freshWorkspaceDb(), 'ws_1', 'Acme', 'org_1', undefined);

    // Absent, not blank — Stripe rejects an empty-string email.
    expect(customerBody().has('email')).toBe(false);
  });

  it('still sends name and metadata alongside the email', async () => {
    await setupWorkspaceBilling(
      env,
      freshWorkspaceDb(),
      'ws_1',
      'Acme',
      'org_1',
      'owner@example.com',
    );

    const body = customerBody();
    expect(body.get('name')).toBe('Acme');
    expect(body.get('metadata[workspaceId]')).toBe('ws_1');
    expect(body.get('metadata[clerkOrgId]')).toBe('org_1');
  });

  it('does not create a customer at all when one already exists', async () => {
    const masterDb = createFakeMasterDb({
      workspaces: [{ stripeCustomerId: 'cus_existing', stripeSubscriptionId: 'sub_existing' }],
    });

    const result = await setupWorkspaceBilling(
      env,
      masterDb,
      'ws_1',
      'Acme',
      'org_1',
      'owner@example.com',
    );

    expect(posted).toHaveLength(0);
    expect(result.customerId).toBe('cus_existing');
  });
});

describe('resolveOwnerEmail → setupWorkspaceBilling', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_123' } as never;

  /**
   * The two halves are wired together in the provisioning workflow's
   * setup-billing step; this covers that seam for each resolution path.
   */
  it.each([
    {
      name: 'payload email reaches Stripe',
      initialMember: { userId: 'user_1', email: 'owner@example.com' },
      userRows: [] as Record<string, unknown>[],
      expected: 'owner@example.com',
    },
    {
      name: 'users-table fallback reaches Stripe',
      initialMember: { userId: 'user_1' },
      userRows: [{ email: 'creator@example.com' }],
      expected: 'creator@example.com',
    },
    {
      name: 'no email resolvable — customer created without one',
      initialMember: undefined,
      userRows: [] as Record<string, unknown>[],
      expected: null,
    },
  ])('$name', async ({ initialMember, userRows, expected }) => {
    const posted: URLSearchParams[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: URLSearchParams }) => {
        posted.push(init.body);
        return {
          ok: true,
          json: async () =>
            url.includes('/customers') ? { id: 'cus_test' } : { id: 'sub_test', status: 'trialing' },
          text: async () => '',
        };
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const masterDb = createFakeMasterDb({
      workspaces: [{ stripeCustomerId: null, stripeSubscriptionId: null }],
      plans: [{ id: 'plan_business', stripePriceIdMonthly: 'price_123' }],
      users: userRows,
    });

    const ownerEmail = await resolveOwnerEmail(masterDb, initialMember);
    await setupWorkspaceBilling(env, masterDb, 'ws_1', 'Acme', 'org_1', ownerEmail);

    expect(posted[0]?.get('email')).toBe(expected);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
