/**
 * Every /api/app-catalog route (the catalog and its access requests) against
 * real pglite master and tenant databases, refusals included. Nothing is
 * mocked but `getMasterDb`, which hands out the test's master database
 * through `conformanceMasterDb`, so the conformance suite runs it against
 * the Rust backend too: the admin check reads real `workspace_members`
 * rows, the licence check real partner and licence rows.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  WELDREACH_APP_CODE,
  WELDREACH_TERMS,
  WELDREACH_TERMS_VERSION,
} from '@weldsuite/app-api-client/schemas/reach';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.db) };
});

import { appCatalogRoutes } from './index';
import { appAccessRoutes } from '../app-access';

const { appCatalog, workspaces, workspaceAppAccess, partners, workspaceLicences } = masterSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let tenant: Database;

const DIRECT = 'org_cat_direct';
const PARTNER = 'org_cat_partner';
const UNLICENSED = 'org_cat_unlicensed';

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.db = master;
  tenant = (await createPgliteDb()).db;

  await master.insert(appCatalog).values([
    {
      id: 'app_c_crm',
      code: 'weldcrm',
      name: 'WeldCRM',
      description: 'CRM',
      icon: 'Users',
      category: 'Sales',
      path: '/crm',
      isPublished: true,
      sortOrder: 2,
      features: ['Pipelines'],
      howItWorks: [{ title: 'Add', description: 'Add a company' }],
      verified: true,
      releasedAt: new Date('2026-01-02T03:04:05.678Z'),
      websiteUrl: 'https://crm.example',
    },
    {
      id: 'app_c_desk',
      code: 'welddesk',
      name: 'WeldDesk',
      description: 'Helpdesk',
      icon: 'LifeBuoy',
      category: 'Customer Support',
      path: '/helpdesk',
      isPublished: true,
      isBeta: true,
      sortOrder: 1,
    },
    {
      id: 'app_c_mail',
      code: 'weldmail',
      name: 'WeldMail',
      description: 'Mail',
      icon: 'Mail',
      category: 'communication',
      path: '/mail',
      isPublished: true,
      sortOrder: 3,
      features: null,
      howItWorks: null,
    },
    {
      id: 'app_c_reach',
      code: WELDREACH_APP_CODE,
      name: 'WeldReach',
      description: 'Cold email',
      icon: 'Send',
      category: 'Sales',
      path: '/weldreach',
      isPublished: true,
      requiresApproval: true,
      sortOrder: 4,
    },
    {
      id: 'app_c_agent',
      code: 'weldagent',
      name: 'WeldAgent',
      description: 'Agents',
      icon: 'Bot',
      category: 'AI',
      path: '/agent',
      isBeta: true,
    },
    {
      id: 'app_c_old',
      code: 'weldold',
      name: 'WeldOld',
      description: 'Retired',
      icon: 'Archive',
      category: 'Other',
      path: '/old',
      isPublished: true,
      isActive: false,
      isBeta: true,
    },
  ]);
  await master.insert(partners).values({ id: 'ptr_cat', name: 'Acme Reseller', billingEmail: 'billing@acme.example' });
  await master.insert(workspaces).values([
    { id: 'ws_cat_direct', clerkOrgId: DIRECT, name: 'Direct Workspace', slug: 'cat-direct' },
    {
      id: 'ws_cat_partner',
      clerkOrgId: PARTNER,
      name: 'Partner Workspace',
      slug: 'cat-partner',
      billingMode: 'partner',
      partnerId: 'ptr_cat',
    },
    {
      id: 'ws_cat_unlicensed',
      clerkOrgId: UNLICENSED,
      name: 'Unlicensed Workspace',
      slug: 'cat-unlicensed',
      billingMode: 'partner',
      partnerId: 'ptr_cat',
    },
  ]);
  await master.insert(workspaceLicences).values({
    id: 'wsl_cat',
    workspaceId: 'ws_cat_partner',
    partnerId: 'ptr_cat',
    allowedApps: ['weldcrm', WELDREACH_APP_CODE],
    resalePricing: {},
  });

  const now = new Date();
  await tenant.insert(schema.workspaceMembers).values([
    { id: 'wm_cat_owner', userId: 'user_cat_owner', email: 'owner@cat.example', role: 'OWNER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_cat_member', userId: 'user_cat_member', email: 'member@cat.example', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await tenant.insert(schema.workspaceInstalledApps).values([
    { id: 'wia_cat_desk', appCode: 'welddesk', isActive: true, displayOrder: 4, settings: { inbox: 'support' } },
    { id: 'wia_cat_mail', appCode: 'weldmail', isActive: false, displayOrder: 2, deletedAt: now, settings: { kept: true } },
  ]);
}, 60_000);

function app(orgId: string | null = DIRECT, userId = 'user_cat_owner') {
  return createTestApp('/api/app-catalog', appCatalogRoutes, {
    context: { orgId, userId, tenantDb: tenant, masterDb: master },
  });
}

function access(orgId: string | null = DIRECT, userId = 'user_cat_owner') {
  return createTestApp('/api/app-catalog', appAccessRoutes, {
    context: { orgId, userId, tenantDb: tenant, masterDb: master },
  });
}

function send(t: ReturnType<typeof app>, path: string, method: string, body?: unknown) {
  return t.request(`/api/app-catalog${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    companyName: ' Acme B.V. ',
    website: 'https://acme.example',
    contactName: 'Lisa de Vries',
    contactEmail: 'lisa@acme.example',
    useCase: 'We email past customers about a new service tier.',
    expectedDailySends: 200,
    targetCountries: ['be', ' fr '],
    listSource: 'own_customers',
    termsVersion: WELDREACH_TERMS_VERSION,
    termsAccepted: [...WELDREACH_TERMS],
    ...overrides,
  };
}

interface Item {
  code: string;
  isInstalled: boolean;
  accessStatus?: string;
  installation?: unknown;
}

describe('GET /api/app-catalog', () => {
  it('lists the published apps in order, with legacy codes and the install state', async () => {
    const res = await app().request('/api/app-catalog');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Item[] };
    expect(data.map((a) => a.code)).toEqual(['helpdesk', 'weldcrm', 'mail', WELDREACH_APP_CODE]);
    expect(data.map((a) => a.isInstalled)).toEqual([true, false, false, false]);
    expect(data[3]!.accessStatus).toBe('none');
    expect(data[0]!.accessStatus).toBeUndefined();
  });

  it('keeps canonical codes on request, and works without an org', async () => {
    const res = await app(null).request('/api/app-catalog?codes=canonical');
    const { data } = (await res.json()) as { data: Item[] };
    expect(data.map((a) => a.code)).toEqual(['welddesk', 'weldcrm', 'weldmail', WELDREACH_APP_CODE]);
    expect(data[3]!.accessStatus).toBe('none');
  });

  it('lists the categories and the beta apps', async () => {
    const categories = await app().request('/api/app-catalog/categories');
    expect(((await categories.json()) as { data: string[] }).data).toEqual(['communication', 'Customer Support', 'Sales']);
    const beta = await app().request('/api/app-catalog/beta');
    expect(((await beta.json()) as { data: string[] }).data.sort()).toEqual(['weldagent', 'welddesk']);
  });
});

describe('GET /api/app-catalog/:code', () => {
  it('returns one app with its installation, accepting legacy codes', async () => {
    const res = await app().request('/api/app-catalog/helpdesk');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Item & { installation: { id: string; settings: unknown } } };
    expect(data.code).toBe('helpdesk');
    expect(data.installation).toMatchObject({ id: 'wia_cat_desk', settings: { inbox: 'support' } });

    const crm = await app().request('/api/app-catalog/weldcrm?codes=canonical');
    expect(((await crm.json()) as { data: Item }).data.installation).toBeNull();
  });

  it('answers 404 for an unpublished, retired or unknown app', async () => {
    for (const code of ['weldagent', 'weldold', 'weldnothing']) {
      expect((await app().request(`/api/app-catalog/${code}`)).status).toBe(404);
    }
  });
});

describe('POST /api/app-catalog/:code/install', () => {
  it('needs an OWNER or ADMIN', async () => {
    const res = await send(app(DIRECT, 'user_cat_member'), '/weldcrm/install', 'POST');
    expect(res.status).toBe(403);
  });

  it('validates an optional body', async () => {
    expect((await send(app(), '/weldcrm/install', 'POST', 'nope')).status).toBe(400);
    const bad = await send(app(), '/weldcrm/install', 'POST', { settings: [] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid install payload',
        details: { formErrors: [], fieldErrors: { settings: ['Expected object, received array'] } },
      },
    });
    expect((await send(app(), '/weldcrm/install', 'POST', [1])).status).toBe(400);
  });

  it('installs a new app at the end of the order, and reinstalls a removed one keeping its settings', async () => {
    const crm = await send(app(), '/weldcrm/install', 'POST');
    expect(crm.status).toBe(201);
    const crmBody = (await crm.json()) as { data: { appCode: string; displayOrder: number; settings: unknown } };
    expect(crmBody.data).toMatchObject({ appCode: 'weldcrm', displayOrder: 5, settings: {} });

    const mail = await send(app(), '/mail/install', 'POST', '  ');
    expect(mail.status).toBe(201);
    expect(((await mail.json()) as { data: { settings: unknown } }).data.settings).toEqual({ kept: true });

    const again = await send(app(), '/mail/install', 'POST', { settings: { fresh: 1 } });
    expect(((await again.json()) as { data: { settings: unknown } }).data.settings).toEqual({ fresh: 1 });
  });

  it('answers 404 for an app that is not in the catalog', async () => {
    expect((await send(app(), '/weldnothing/install', 'POST')).status).toBe(404);
  });

  it('limits a partner-managed workspace to its licence', async () => {
    const refused = await send(app(PARTNER), '/weldmail/install', 'POST');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: {
        code: 'APP_NOT_LICENSED',
        message: 'This workspace is not licensed for weldmail.',
        details: { app: 'weldmail' },
      },
    });
    expect((await send(app(UNLICENSED), '/weldcrm/install', 'POST')).status).toBe(403);
    expect((await send(app(PARTNER), '/weldcrm/install', 'POST')).status).toBe(201);
  });

  it('installs an app on request only once access is approved', async () => {
    const none = await send(app(), `/${WELDREACH_APP_CODE}/install`, 'POST');
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'APP_ACCESS_REQUIRED',
      details: { appCode: WELDREACH_APP_CODE, status: 'none' },
    });
    expect((await send(app(null), `/${WELDREACH_APP_CODE}/install`, 'POST')).status).toBe(403);

    await master.insert(workspaceAppAccess).values({
      id: 'waa_cat_partner',
      workspaceId: 'ws_cat_partner',
      appCode: WELDREACH_APP_CODE,
      status: 'approved',
    });
    expect((await send(app(PARTNER), `/${WELDREACH_APP_CODE}/install`, 'POST')).status).toBe(201);
  });
});

describe('DELETE /api/app-catalog/:code/install', () => {
  it('needs an OWNER or ADMIN', async () => {
    const res = await app(DIRECT, 'user_cat_member').request('/api/app-catalog/helpdesk/install', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('uninstalls an installed app, then answers 404', async () => {
    const first = await app().request('/api/app-catalog/helpdesk/install', { method: 'DELETE' });
    expect(first.status).toBe(204);
    const second = await app().request('/api/app-catalog/helpdesk/install', { method: 'DELETE' });
    expect(second.status).toBe(404);
  });
});

describe('/api/app-catalog/:code/access-request', () => {
  const url = `/${WELDREACH_APP_CODE}/access-request`;

  it('asks for an organization', async () => {
    expect((await access(null).request(`/api/app-catalog${url}`)).status).toBe(400);
    expect((await send(access(null), url, 'POST', requestBody())).status).toBe(400);
  });

  it('answers data null before the workspace asked', async () => {
    const res = await access().request(`/api/app-catalog${url}`);
    expect(await res.json()).toEqual({ data: null });
  });

  it('refuses members, apps not on request, and unlicensed partner workspaces', async () => {
    expect((await send(access(DIRECT, 'user_cat_member'), url, 'POST', requestBody())).status).toBe(403);
    expect((await send(access(), '/weldcrm/access-request', 'POST', requestBody())).status).toBe(404);
    expect((await send(access(), '/weldold/access-request', 'POST', requestBody())).status).toBe(404);
    expect((await send(access(UNLICENSED), url, 'POST', requestBody())).status).toBe(403);
  });

  it('validates the body and the terms', async () => {
    expect((await send(access(), url, 'POST', 'nope')).status).toBe(400);
    const invalid = await send(
      access(),
      url,
      'POST',
      requestBody({ contactEmail: 'not-an-email', targetCountries: ['bel'], expectedDailySends: 0, termsAccepted: [] }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid access request',
        details: {
          formErrors: [],
          fieldErrors: {
            contactEmail: ['Invalid email'],
            expectedDailySends: ['Number must be greater than or equal to 1'],
            targetCountries: ['String must contain exactly 2 character(s)'],
            termsAccepted: ['Array must contain at least 1 element(s)'],
          },
        },
      },
    });
    expect((await send(access(), url, 'POST', [requestBody()])).status).toBe(400);
    const missingTerm = await send(
      access(),
      url,
      'POST',
      requestBody({ termsAccepted: WELDREACH_TERMS.filter((t) => t !== 'lawful_lists') }),
    );
    expect(((await missingTerm.json()) as { error: { message: string } }).error.message).toBe(
      'Every term must be accepted. Missing: lawful_lists.',
    );
    expect((await send(access(), url, 'POST', requestBody({ termsVersion: 'weldreach-2025-01' }))).status).toBe(400);
  });

  it('files the request, then refuses a second one', async () => {
    const res = await send(access(), url, 'POST', requestBody({ listSourceDetails: ' CRM export ' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { status: string; request: Record<string, unknown>; limits: unknown } };
    expect(data.status).toBe('requested');
    expect(data.request).toMatchObject({ companyName: 'Acme B.V.', targetCountries: ['BE', 'FR'], listSourceDetails: 'CRM export' });

    const read = await access().request(`/api/app-catalog${url}`);
    expect(((await read.json()) as { data: { status: string } }).data.status).toBe('requested');

    const again = await send(access(), url, 'POST', requestBody());
    expect(again.status).toBe(409);
  });

  it('files again after a rejection', async () => {
    await master
      .update(workspaceAppAccess)
      .set({ status: 'rejected', rejectionReason: 'Too vague', reviewedAt: new Date('2026-02-03T04:05:06.000Z') })
      .where(eq(workspaceAppAccess.workspaceId, 'ws_cat_direct'));
    const res = await send(access(), url, 'POST', requestBody({ listSource: 'other' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { rejectionReason: unknown; reviewedAt: unknown } };
    expect(data.rejectionReason).toBeNull();
    expect(data.reviewedAt).toBeNull();
  });

  it('answers 404 for an org without a workspace', async () => {
    expect((await send(access('org_cat_nowhere'), url, 'POST', requestBody())).status).toBe(404);
  });
});
