/**
 * The Global inventory's SQL against the real schema: every master and tenant
 * migration in the journal is applied to PGlite, and each probe must run
 * without an error (a wrong table or column fails here, not against
 * production). Clerk and mail-api are faked.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  clerkInventory,
  formatInventoryReport,
  mailStoreModes,
  masterInventory,
  sanitizeError,
  tenantInventory,
  type GlobalInventory,
  type Query,
} from './global-inventory';

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '../../../../../packages/core/db/drizzle');

/** Applies a migration folder's journal the way the runner does, tolerating the historic re-creates. */
async function migrated(folder: string): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pg_trgm } });
  const dir = path.join(drizzleDir, folder);
  const journal = JSON.parse(await readFile(path.join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  for (const { tag } of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const raw = await readFile(path.join(dir, `${tag}.sql`), 'utf8');
    for (const statement of raw.split(/-->\s*statement-breakpoint/).map((s) => s.trim()).filter(Boolean)) {
      try {
        await db.exec(statement);
      } catch (err) {
        const message = (err as Error).message;
        if (/already exists/i.test(message) || /does not exist/i.test(message)) continue;
        throw new Error(`${folder}/${tag}: ${message}`);
      }
    }
  }
  return db;
}

const queryOf =
  (db: PGlite): Query =>
  async (text, params) =>
    (await db.query<Record<string, unknown>>(text, params)).rows;

let master: PGlite;
let tenant: PGlite;

beforeAll(async () => {
  [master, tenant] = await Promise.all([migrated('master-migrations'), migrated('tenant-migrations')]);
}, 600_000);

describe('Global inventory SQL on the migrated schema', () => {
  it('reads the master database without an error', async () => {
    const inv = await masterInventory(queryOf(master));
    expect(inv.errors).toEqual([]);
    expect(inv.workspaces).toEqual([]);
  });

  it('reads a tenant database without an error', async () => {
    const inv = await tenantInventory(queryOf(tenant));
    expect(inv.errors).toEqual([]);
    expect(inv.databaseBytes).toBeGreaterThan(0);
    expect(inv.pending['sequence_enrollments.active']).toBe(0);
  });

  it('records a failing probe under its label and keeps going', async () => {
    const failing: Query = async (text) => {
      if (text.includes('from users')) throw new Error('boom at postgres://user:secret@host/db');
      return queryOf(master)(text);
    };
    const inv = await masterInventory(failing);
    expect(inv.errors).toEqual(['users: boom at <redacted-connection-string>']);
    expect(inv.users).toEqual({ total: 0, active: 0 });
  });
});

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    const key = `${url.pathname}${url.search}`;
    const match = Object.keys(routes).find((k) => key.startsWith(k));
    if (!match) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[match]), { status: 200 });
  }) as typeof fetch;
}

describe('Clerk inventory', () => {
  it('counts sign-in methods and social providers over every page, without identifying anyone', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      password_enabled: true,
      totp_enabled: i < 3,
      external_accounts: i < 10 ? [{ provider: 'oauth_google' }, { provider: 'oauth_google' }] : [],
    }));
    const page2 = [{ password_enabled: false, passkeys: [{}], external_accounts: [{ provider: 'oauth_microsoft' }], banned: true }];
    const inv = await clerkInventory(
      'sk_test',
      fakeFetch({
        '/v1/users?limit=500&offset=0': page1,
        '/v1/users?limit=500&offset=500': page2,
        '/v1/saml_connections': { data: [{ active: true }, { active: false }], total_count: 2 },
        '/v1/oauth_applications': { data: [{}, {}, {}], total_count: 3 },
      }),
    );
    expect(inv).toMatchObject({
      users: 501,
      withPassword: 500,
      withTotp: 3,
      withPasskeys: 1,
      banned: 1,
      externalProviders: { oauth_google: 10, oauth_microsoft: 1 },
      samlConnections: { total: 2, active: 1 },
      oauthApplications: 3,
      errors: [],
    });
  });

  it('records a refused call and carries on', async () => {
    const inv = await clerkInventory('sk_test', fakeFetch({ '/v1/users': [] }));
    expect(inv.users).toBe(0);
    expect(inv.errors).toEqual([
      'clerk saml_connections: Clerk /saml_connections: HTTP 404',
      'clerk oauth_applications: Clerk /oauth_applications: HTTP 404',
    ]);
  });
});

describe('mailbox store modes', () => {
  it('counts each mailbox by mode, failures included', async () => {
    const modes = await mailStoreModes(
      { baseUrl: 'https://mail-api.example', secret: 's', adminEmail: 'a@example.com' },
      'ws_1',
      fakeFetch({
        '/internal/mail-store/status/all': {
          data: [{ accountId: 'a', status: { mode: 'postgres' } }, { accountId: 'b', status: { mode: 'object-only' } }, { accountId: 'c', error: 'x' }],
        },
      }),
    );
    expect(modes).toEqual({ postgres: 1, 'object-only': 1, '(error)': 1 });
  });
});

describe('report', () => {
  it('answers the open questions and lists every workspace', async () => {
    const tenantInv = await tenantInventory(queryOf(tenant));
    const inv: GlobalInventory = {
      generatedAt: '2026-11-18T00:00:00.000Z',
      master: {
        ...(await masterInventory(queryOf(master))),
        workspaces: [
          {
            id: 'ws_a',
            planSlug: 'pro',
            isActive: true,
            deleted: false,
            deletionScheduled: false,
            provisioningStatus: 'ready',
            createdAt: null,
            subscriptionStatus: 'active',
            subscriptionCycle: 'monthly',
            billingMode: null,
            partnerManaged: false,
            hasStripeSubscription: true,
            purchasedSeats: 3,
            placement: 'shared',
            region: 'aws-eu-central-1',
            membersActive: 3,
            membersPending: 0,
          },
        ],
        sso: [{ workspaceId: 'ws_a', provider: 'saml', enabled: true, clerkActive: true }],
      },
      workspaces: [
        { id: 'ws_a', tenant: tenantInv, tenantSkipped: null, mailStoreModes: { 'object-only': 2 } },
        { id: 'ws_b', tenant: null, tenantSkipped: 'no tenant database', mailStoreModes: null },
      ],
      clerk: null,
      mailStoreChecked: true,
    };
    const md = formatInventoryReport(inv);
    expect(md).toContain('1 workspace(s) with SSO enabled: ws_a (saml)');
    expect(md).toContain('Workspaces with mailboxes in Durable Objects: ws_a');
    expect(md).toContain('5. **Regions.** aws-eu-central-1 1.');
    expect(md).toContain('| `ws_a` | pro | active | shared, aws-eu-central-1 | 3 |');
    expect(md).toContain('- ws_b: no tenant database');
  });

  it('never prints a connection string', () => {
    expect(sanitizeError(new Error('connect postgresql://u:p@h:5432/d failed'))).toBe('connect <redacted-connection-string> failed');
  });
});
