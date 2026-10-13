/**
 * GET / POST /api/app-catalog/:code/access-request against a real pglite
 * master DB: the role check, the terms check, the re-request rules, the 409s,
 * the KV cache drop and the staff notification.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  WELDREACH_APP_CODE,
  WELDREACH_DEFAULT_LIMITS,
  WELDREACH_TERMS,
  WELDREACH_TERMS_VERSION,
  type AppAccessStatus,
} from '@weldsuite/app-api-client/schemas/reach';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.db };
});
vi.mock('@weldsuite/mail-domain/access', () => ({ isAdminOrOwner: vi.fn(async () => true) }));
vi.mock('../../services/partner/managed', async (orig) => {
  const actual = await orig<typeof import('../../services/partner/managed')>();
  return { ...actual, getManagedContext: vi.fn(async () => null) };
});
vi.mock('../../services/app-access-notify', () => ({ notifyAccessRequested: vi.fn(async () => undefined) }));

import { appAccessRoutes } from './index';
import { isAdminOrOwner } from '@weldsuite/mail-domain/access';
import * as managedService from '../../services/partner/managed';
import { notifyAccessRequested } from '../../services/app-access-notify';

const { workspaces, workspaceAppAccess, appCatalog } = masterSchema;

const mockedAdmin = vi.mocked(isAdminOrOwner);
const mockedManaged = vi.mocked(managedService.getManagedContext);
const mockedNotify = vi.mocked(notifyAccessRequested);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for postgres-js
let db: any;
let seq = 0;

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db;
  state.db = db;
  await db.insert(appCatalog).values([
    {
      id: 'app_r_reach',
      code: WELDREACH_APP_CODE,
      name: 'WeldReach',
      description: 'Cold email',
      icon: 'Mail',
      category: 'Marketing',
      path: '/weldreach',
      isPublished: true,
      requiresApproval: true,
    },
    {
      id: 'app_r_crm',
      code: 'weldcrm',
      name: 'WeldCRM',
      description: 'CRM',
      icon: 'Users',
      category: 'Sales',
      path: '/crm',
      isPublished: true,
    },
    {
      id: 'app_r_old',
      code: 'weldold',
      name: 'WeldOld',
      description: 'Retired',
      icon: 'Archive',
      category: 'Other',
      path: '/old',
      isActive: false,
      requiresApproval: true,
    },
  ]);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockedAdmin.mockResolvedValue(true);
  mockedManaged.mockResolvedValue(null);
});

async function seedWorkspace(): Promise<{ id: string; orgId: string }> {
  seq += 1;
  const id = `ws_req_${seq}`;
  const orgId = `org_req_${seq}`;
  await db.insert(workspaces).values({ id, clerkOrgId: orgId, name: `Request Workspace ${seq}`, slug: `ws-req-${seq}` });
  return { id, orgId };
}

async function rowOf(workspaceId: string) {
  const [row] = await db.select().from(workspaceAppAccess).where(eq(workspaceAppAccess.workspaceId, workspaceId));
  return row as typeof workspaceAppAccess.$inferSelect | undefined;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    companyName: 'Acme B.V.',
    website: 'https://acme.example',
    contactName: 'Lisa de Vries',
    contactEmail: 'lisa@acme.example',
    useCase: 'We email past customers about a new service tier.',
    expectedDailySends: 200,
    targetCountries: ['be', 'FR'],
    listSource: 'own_customers',
    termsVersion: WELDREACH_TERMS_VERSION,
    termsAccepted: [...WELDREACH_TERMS],
    ...overrides,
  };
}

interface Harness {
  request: ReturnType<typeof createTestApp>['request'];
  kvDelete: ReturnType<typeof vi.fn>;
}

function harness(orgId: string | null, userId = 'user_owner'): Harness {
  const kvDelete = vi.fn(async () => undefined);
  const { request } = createTestApp('/api/app-catalog', appAccessRoutes, {
    context: { orgId, userId },
    env: { WORKSPACE_CACHE: { delete: kvDelete } as unknown as KVNamespace },
  });
  return { request, kvDelete };
}

const url = (code = WELDREACH_APP_CODE) => `/api/app-catalog/${code}/access-request`;
const post = (h: Harness, payload: unknown, code = WELDREACH_APP_CODE) =>
  h.request(url(code), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

describe('GET /:code/access-request', () => {
  it('answers data null when the workspace never asked', async () => {
    const ws = await seedWorkspace();
    const res = await harness(ws.orgId).request(url());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });

  it('returns the workspace\'s request without staff-only fields', async () => {
    const ws = await seedWorkspace();
    await post(harness(ws.orgId), body());
    await db
      .update(workspaceAppAccess)
      .set({ reviewNotes: 'internal note', reviewedBy: 'staff@weldsuite.org', stripeSubscriptionId: 'sub_1' })
      .where(eq(workspaceAppAccess.workspaceId, ws.id));

    const res = await harness(ws.orgId).request(url());

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toMatchObject({ appCode: WELDREACH_APP_CODE, status: 'requested' });
    expect(JSON.stringify(json)).not.toMatch(/internal note|staff@weldsuite\.org|sub_1|reviewNotes/);
  });

  it('does not show another workspace\'s request', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    await post(harness(a.orgId), body());

    const res = await harness(b.orgId).request(url());

    expect(await res.json()).toEqual({ data: null });
  });

  it('is open to members, not only admins', async () => {
    const ws = await seedWorkspace();
    mockedAdmin.mockResolvedValue(false);
    const res = await harness(ws.orgId).request(url());
    expect(res.status).toBe(200);
  });

  it('asks for an organization when the request has none', async () => {
    const res = await harness(null).request(url());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORG_REQUIRED');
  });
});

describe('POST /:code/access-request', () => {
  it('files the request: 201, requested, default limits, receipt, cache dropped, staff told', async () => {
    const ws = await seedWorkspace();
    const h = harness(ws.orgId, 'user_owner');

    const res = await post(h, body({ listSourceDetails: 'CRM export' }));

    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: Record<string, unknown> & { request: Record<string, unknown> } };
    expect(json.data).toMatchObject({
      appCode: WELDREACH_APP_CODE,
      status: 'requested',
      limits: WELDREACH_DEFAULT_LIMITS,
      rejectionReason: null,
    });
    expect(json.data.request).toMatchObject({
      companyName: 'Acme B.V.',
      targetCountries: ['BE', 'FR'],
      termsVersion: WELDREACH_TERMS_VERSION,
      termsAcceptedBy: 'user_owner',
    });
    expect(typeof json.data.request.termsAcceptedAt).toBe('string');

    const row = await rowOf(ws.id);
    expect(row?.status).toBe('requested');
    expect(row?.requestedBy).toBe('user_owner');

    expect(h.kvDelete).toHaveBeenCalledWith(`appaccess:${ws.orgId}:${WELDREACH_APP_CODE}`);
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appCode: WELDREACH_APP_CODE,
        workspaceId: ws.id,
        workspaceName: expect.stringMatching(/^Request Workspace/),
        input: expect.objectContaining({ companyName: 'Acme B.V.', targetCountries: ['BE', 'FR'] }),
      }),
    );
  });

  it('still files the request when the KV delete fails', async () => {
    const ws = await seedWorkspace();
    const h = harness(ws.orgId);
    h.kvDelete.mockRejectedValueOnce(new Error('kv down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await post(h, body());

    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it('refuses a member who is not an admin or owner, and writes nothing', async () => {
    const ws = await seedWorkspace();
    mockedAdmin.mockResolvedValue(false);

    const res = await post(harness(ws.orgId), body());

    expect(res.status).toBe(403);
    expect(await rowOf(ws.id)).toBeUndefined();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('answers 404 for an app that does not exist', async () => {
    const ws = await seedWorkspace();
    const res = await post(harness(ws.orgId), body(), 'weldnothing');
    expect(res.status).toBe(404);
  });

  it('answers 404 for an app that is not on request only', async () => {
    const ws = await seedWorkspace();
    const res = await post(harness(ws.orgId), body(), 'weldcrm');
    expect(res.status).toBe(404);
    expect(await rowOf(ws.id)).toBeUndefined();
  });

  it('answers 404 for an on-request app that was switched off', async () => {
    const ws = await seedWorkspace();
    const res = await post(harness(ws.orgId), body(), 'weldold');
    expect(res.status).toBe(404);
  });

  it('answers 400 for a body that fails the schema', async () => {
    const ws = await seedWorkspace();
    const res = await post(harness(ws.orgId), body({ contactEmail: 'not-an-email', targetCountries: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    expect(await rowOf(ws.id)).toBeUndefined();
  });

  it('answers 400 for a body that is not JSON', async () => {
    const ws = await seedWorkspace();
    const res = await harness(ws.orgId).request(url(), { method: 'POST', body: 'nope' });
    expect(res.status).toBe(400);
  });

  it('answers 400 when a term is not ticked', async () => {
    const ws = await seedWorkspace();
    const res = await post(
      harness(ws.orgId),
      body({ termsAccepted: WELDREACH_TERMS.filter((t) => t !== 'identify_and_opt_out') }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('identify_and_opt_out');
    expect(await rowOf(ws.id)).toBeUndefined();
  });

  it('answers 400 for an out-of-date terms version', async () => {
    const ws = await seedWorkspace();
    const res = await post(harness(ws.orgId), body({ termsVersion: 'weldreach-2025-01' }));
    expect(res.status).toBe(400);
    expect(await rowOf(ws.id)).toBeUndefined();
  });

  it.each(['requested', 'approved', 'suspended'] as const)('answers 409 APP_ACCESS_EXISTS while %s', async (status) => {
    const ws = await seedWorkspace();
    await db.insert(workspaceAppAccess).values({
      id: `waa_r_${ws.id}`,
      workspaceId: ws.id,
      appCode: WELDREACH_APP_CODE,
      status,
    });

    const res = await post(harness(ws.orgId), body());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'APP_ACCESS_EXISTS',
        message: `Access to ${WELDREACH_APP_CODE} is already ${status}.`,
        details: { appCode: WELDREACH_APP_CODE, status },
      },
    });
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('answers 409 when a second request is filed right after the first', async () => {
    const ws = await seedWorkspace();
    expect((await post(harness(ws.orgId), body())).status).toBe(201);
    expect((await post(harness(ws.orgId), body())).status).toBe(409);
    expect(mockedNotify).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'revoked'] as const satisfies readonly AppAccessStatus[])(
    'lets a workspace ask again after %s and keeps the limits staff set',
    async (status) => {
      const ws = await seedWorkspace();
      await db.insert(workspaceAppAccess).values({
        id: `waa_r_${ws.id}`,
        workspaceId: ws.id,
        appCode: WELDREACH_APP_CODE,
        status,
        limits: { ...WELDREACH_DEFAULT_LIMITS, maxDailySends: 900 },
        rejectionReason: 'Explain your lists',
      });

      const res = await post(harness(ws.orgId), body());

      expect(res.status).toBe(201);
      const json = (await res.json()) as { data: { status: string; rejectionReason: string | null; limits: { maxDailySends: number } } };
      expect(json.data.status).toBe('requested');
      expect(json.data.rejectionReason).toBeNull();
      expect(json.data.limits.maxDailySends).toBe(900);
      expect(mockedNotify).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a partner workspace whose licence does not list the app', async () => {
    const ws = await seedWorkspace();
    mockedManaged.mockResolvedValue({
      workspaceId: ws.id,
      partner: { id: 'ptr_1', name: 'Reseller' },
      partnerStatus: 'active',
      licence: { status: 'active', allowedApps: ['welddesk'], monthlyCredits: 100, maxSeats: null },
    } as unknown as Awaited<ReturnType<typeof managedService.getManagedContext>>);

    const res = await post(harness(ws.orgId), body());

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_NOT_LICENSED');
    expect(await rowOf(ws.id)).toBeUndefined();
  });

  it('answers 404 for an org without a workspace row', async () => {
    const res = await post(harness('org_without_workspace'), body());
    expect(res.status).toBe(404);
  });

  it('asks for an organization when the request has none', async () => {
    const res = await post(harness(null), body());
    expect(res.status).toBe(400);
  });
});
