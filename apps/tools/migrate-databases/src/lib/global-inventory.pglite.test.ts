/**
 * The Global inventory's SQL against the real schema: every master and tenant
 * migration in the journal is applied to PGlite, and each probe must run
 * without an error (a wrong table or column fails here, not against
 * production). Clerk and mail-api are faked.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readOnlyConnection, runGlobalInventory } from './global-inventory-run';
import {
  clerkInventory,
  formatInventoryReport,
  mailStoreAdminFromEnv,
  mailStoreModes,
  masterInventory,
  sanitizeError,
  tenantInventory,
  type GlobalInventory,
  type Query,
  type WorkspaceRow,
} from './global-inventory';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../../../rust/migrations');

/** Applies a migration folder's journal the way the runner does, tolerating the historic re-creates. */
async function migrated(folder: string): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pg_trgm } });
  const dir = path.join(migrationsDir, folder);
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
  [master, tenant] = await Promise.all([migrated('master'), migrated('tenant')]);
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

  it("counts brought mail domains apart from the workspace's weldmail domain, and WeldHost's DNSSEC zones", async () => {
    await tenant.exec(`
      insert into mail_domains (id, domain_name, is_active) values
        ('mdom_t_custom', 'acme.test', true),
        ('mdom_t_weldmail', 'acme.weldmail.com', true),
        ('mdom_t_test', 'acme.WeldMail.org', true),
        ('mdom_t_off', 'old.test', false);
      insert into domains (id, name, tld, full_domain, registrar) values
        ('dom_t_1', 'acme', 'test', 'acme.test', 'cloudflare'),
        ('dom_t_2', 'other', 'test', 'other.test', null);
      insert into dns_zones (id, domain_id, name, provider, dnssec_enabled) values
        ('dnsz_t_1', 'dom_t_1', 'acme.test', 'cloudflare', true),
        ('dnsz_t_2', 'dom_t_2', 'other.test', 'cloudflare', false);
    `);
    try {
      const inv = await tenantInventory(queryOf(tenant));
      expect(inv.errors).toEqual([]);
      expect(inv.mail).toMatchObject({ customDomains: 1, weldmailDomains: 2 });
      expect(inv.weldhost).toEqual({
        domainsByRegistrar: { cloudflare: 1, '(none)': 1 },
        zonesByProvider: { cloudflare: 2 },
        dnssecZones: 1,
      });
    } finally {
      await tenant.exec(`
        delete from dns_zones where id in ('dnsz_t_1', 'dnsz_t_2');
        delete from domains where id in ('dom_t_1', 'dom_t_2');
        delete from mail_domains where id like 'mdom_t_%';
      `);
    }
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
      external_accounts:
        i < 10 ? [{ provider: 'oauth_google', provider_user_id: i < 8 ? `g${i}` : null }, { provider: 'oauth_google' }] : [],
    }));
    const page2 = [
      { password_enabled: false, passkeys: [{}], external_accounts: [{ provider: 'oauth_microsoft', provider_user_id: ' ' }], banned: true },
    ];
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
      externalWithSubject: { oauth_google: 8 },
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
    expect(md).toContain('5. **Regions.** Live workspaces by region: aws-eu-central-1 1. Outside aws-eu-central-1: 0 (0 with an active member).');
    expect(md).toContain('| `ws_a` | pro | active | shared, aws-eu-central-1 | 3 |');
    expect(md).toContain('- ws_b: no tenant database');
  });

  it('never prints a connection string', () => {
    expect(sanitizeError(new Error('connect postgresql://u:p@h:5432/d failed'))).toBe('connect <redacted-connection-string> failed');
  });
});

describe('the inventory run over the Postgres wire protocol', () => {
  it('reads every workspace through read-only transactions and writes both reports', async () => {
    const masterPort = 40_000 + Math.floor(Math.random() * 10_000);
    const tenantPort = masterPort + 1;
    const masterUrl = `postgres://postgres@127.0.0.1:${masterPort}/postgres`;
    const servers = [
      new PGLiteSocketServer({ db: master, port: masterPort }),
      new PGLiteSocketServer({ db: tenant, port: tenantPort }),
    ];
    await master.query(
      "insert into workspaces (id, name, slug, database_url) values ('ws_run_a', 'A', 'run-a', $1), ('ws_run_b', 'B', 'run-b', null)",
      [`postgres://postgres@127.0.0.1:${tenantPort}/postgres`],
    );
    const out = await mkdtemp(path.join(os.tmpdir(), 'global-inventory-'));
    try {
      for (const server of servers) await server.start();
      const logged: string[] = [];
      const inv = await runGlobalInventory({
        env: { DATABASE_URL_MASTER: masterUrl, CLERK_SECRET_KEY: 'sk_test' },
        outDir: out,
        log: (line) => logged.push(line),
        fetchFn: fakeFetch({
          '/v1/users': [],
          '/v1/saml_connections': { data: [], total_count: 0 },
          '/v1/oauth_applications': { data: [], total_count: 0 },
        }),
      });

      const byId = new Map(inv.workspaces.map((w) => [w.id, w]));
      expect([...byId.keys()].sort()).toEqual(['ws_run_a', 'ws_run_b']);
      expect(byId.get('ws_run_a')?.tenant?.errors).toEqual([]);
      expect(byId.get('ws_run_b')?.tenantSkipped).toBe('no tenant database');
      expect(inv.clerk).toMatchObject({ users: 0, oauthApplications: 0, errors: [] });
      expect(await readFile(path.join(out, 'global-inventory.md'), 'utf8')).toContain('`ws_run_a`');
      expect(JSON.parse(await readFile(path.join(out, 'global-inventory.json'), 'utf8')).workspaces).toHaveLength(2);
      expect(logged).toContain('Reading Clerk…');

      // A write is refused inside the inventory's transactions, and nothing is left on the session afterwards.
      const conn = readOnlyConnection(masterUrl);
      try {
        await expect(conn.query("insert into workspaces (id, name, slug) values ('ws_x', 'X', 'x')")).rejects.toThrow(
          /read-only transaction/,
        );
        const [row] = await conn.sql`show transaction_read_only`;
        expect(row?.transaction_read_only).toBe('off');
      } finally {
        await conn.sql.end({ timeout: 5 });
      }
    } finally {
      for (const server of servers) await server.stop();
      await master.query("delete from workspaces where id in ('ws_run_a', 'ws_run_b')");
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('needs MASTER_DATABASE_URL', async () => {
    await expect(runGlobalInventory({ env: {}, outDir: os.tmpdir() })).rejects.toThrow(
      'MASTER_DATABASE_URL (or DATABASE_URL_MASTER) is required',
    );
  });
});

describe('report branches', () => {
  const row = (id: string, over: Partial<WorkspaceRow>): WorkspaceRow => ({
    id,
    planSlug: null,
    isActive: true,
    deleted: false,
    deletionScheduled: false,
    provisioningStatus: null,
    createdAt: null,
    subscriptionStatus: null,
    subscriptionCycle: null,
    billingMode: null,
    partnerManaged: false,
    hasStripeSubscription: false,
    purchasedSeats: 0,
    placement: 'none',
    region: null,
    membersActive: 0,
    membersPending: 0,
    ...over,
  });

  it('covers workspace states, Clerk with SAML, unread mailbox modes, plans and API users', async () => {
    const tenantInv = await tenantInventory(queryOf(tenant));
    const busy = {
      ...tenantInv,
      apiKeys: { ...tenantInv.apiKeys, workspaceKeysUsed30d: 2 },
      portals: { commercePortalEnabled: true, commercePortalAccounts: 4, projectPortalStakeholders: 1 },
      integrations: [
        { source: 'integration_connections', provider: 'hubspot', status: 'active', count: 1 },
        { source: 'bank_connections', provider: 'ponto', status: 'error', count: 1 },
      ],
      phoneNumbers: { telnyx: 2 },
      mail: { ...tenantInv.mail, customDomains: 2, weldmailDomains: 1 },
      weldhost: { domainsByRegistrar: { cloudflare: 2, '(none)': 1 }, zonesByProvider: { cloudflare: 2 }, dnssecZones: 1 },
      errors: ['mail_domains: boom'],
    };
    const inv: GlobalInventory = {
      generatedAt: '2026-11-18T00:00:00.000Z',
      master: {
        ...(await masterInventory(queryOf(master))),
        workspaces: [
          row('ws_live', { planSlug: 'pro', placement: 'dedicated', region: 'aws-us-east-2', partnerManaged: true }),
          row('ws_gone', { deleted: true }),
          row('ws_leaving', { deletionScheduled: true }),
          row('ws_off', { isActive: false }),
        ],
        plans: [{ id: 'plan_1', slug: null, currency: null, priceMonthly: 10, priceYearly: 100, pricePerUser: 5 }],
        sso: [{ workspaceId: 'ws_live', provider: null, enabled: true, clerkActive: null }],
        errors: ['partners: boom'],
      },
      workspaces: [
        { id: 'ws_live', tenant: busy, tenantSkipped: null, mailStoreModes: null },
        { id: 'ws_gone', tenant: null, tenantSkipped: null, mailStoreModes: null },
        { id: 'ws_leaving', tenant: null, tenantSkipped: null, mailStoreModes: null },
        { id: 'ws_off', tenant: null, tenantSkipped: null, mailStoreModes: null },
        { id: 'ws_unknown', tenant: null, tenantSkipped: null, mailStoreModes: null },
      ],
      clerk: {
        users: 3,
        withPassword: 2,
        withTotp: 1,
        withBackupCodes: 0,
        withTwoFactor: 1,
        withPasskeys: 0,
        withEnterpriseAccount: 1,
        banned: 0,
        externalProviders: { oauth_google: 1 },
        externalWithSubject: { oauth_google: 1 },
        samlConnections: { total: 1, active: 1 },
        oauthApplications: 2,
        errors: ['clerk oauth_applications: HTTP 500'],
      },
      mailStoreChecked: false,
    };
    const md = formatInventoryReport(inv);
    expect(md).toContain('1 workspace(s) with SSO enabled: ws_live (?)');
    expect(md).toContain('Clerk SAML connections: 1 (1 active); users with an enterprise account: 1.');
    expect(md).toContain('2. **Clerk.** 3 users: 2 with a password, 1 with TOTP');
    expect(md).toContain('Social links: oauth_google 1; with a provider subject: oauth_google 1.');
    expect(md).toContain('3. **DNSSEC.** WeldHost zones with DNSSEC on: 1 (ws_live)');
    expect(md).toContain('Domains by registrar: (none) 1, cloudflare 2.');
    expect(md).toContain('Outside aws-eu-central-1: 1 (0 with an active member).');
    expect(md).toContain('- Workspaces: 4 (2 active and not deleted; of those, 0 with an active member and 1 without a tenant database)');
    expect(md).toContain('- Custom mail domains: 2 (plus 1 workspace weldmail domains)');
    expect(md).toContain('4. **Mailbox store modes.** Not read');
    expect(md).toContain('Commerce portal enabled in 1 workspace(s) (ws_live)');
    expect(md).toContain('   - `plan_1`: ? 10/month, 100/year, 5/user');
    expect(md).toContain('Workspaces with an API key used in the last 30 days: 1 (ws_live)');
    expect(md).toContain('Clerk OAuth applications (MCP clients): 2.');
    expect(md).toContain('| `ws_live` | pro | active | dedicated, aws-us-east-2 |');
    expect(md).toContain('| `ws_gone` | — | deleted |');
    expect(md).toContain('| `ws_leaving` | — | deleting |');
    expect(md).toContain('| `ws_off` | — | inactive |');
    expect(md).toContain('| `ws_unknown` | — | ? | — |');
    expect(md).toContain('- Connected integrations: hubspot (active) 1, ponto (error) 1');
    expect(md).toContain('- master: partners: boom');
    expect(md).toContain('- clerk: clerk oauth_applications: HTTP 500');
    expect(md).toContain('- ws_live: mail_domains: boom');
  });

  it('reads the mailbox-store admin settings only when all three are set', () => {
    expect(mailStoreAdminFromEnv({ MAIL_STORE_ADMIN_URL: 'https://mail-api.example//', OUTBOUND_ADMIN_SECRET: 's', MAIL_STORE_ADMIN_EMAIL: 'a@b' })).toEqual({
      baseUrl: 'https://mail-api.example',
      secret: 's',
      adminEmail: 'a@b',
    });
    expect(mailStoreAdminFromEnv({ MAIL_STORE_ADMIN_URL: 'https://mail-api.example' })).toBeNull();
  });

  it('throws when the mailbox-store status call is refused', async () => {
    await expect(
      mailStoreModes({ baseUrl: 'https://mail-api.example', secret: 's', adminEmail: 'a@b' }, 'ws_1', fakeFetch({})),
    ).rejects.toThrow('mail-store status: HTTP 404');
  });
});
