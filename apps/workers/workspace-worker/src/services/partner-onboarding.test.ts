/**
 * onboardPartnerWorkspace: Clerk org without the partner user, owner invited by
 * email as OWNER, master rows via core-domain, provisioning started with the
 * licensed apps. The master DB, core-domain and the provisioning kickoff are
 * mocked; Clerk is a stubbed `fetch`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const update = vi.fn();
const planRows: { current: unknown[] } = { current: [{ id: 'plan_free' }] };

vi.mock('../db', () => ({
  getMasterDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => planRows.current }) }) }),
    update: () => ({ set: (v: unknown) => ({ where: async () => update(v) }) }),
  }),
}));

vi.mock('@weldsuite/core-domain/partners', () => ({
  LicenceError: class LicenceError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  assertPartnerOnboardAllowed: vi.fn(async () => undefined),
  findRecentPartnerWorkspace: vi.fn(async () => null),
  getPartner: vi.fn(async () => ({ id: 'ptr_1', name: 'Acme Partner' })),
  registerPartnerWorkspace: vi.fn(async () => ({ workspaceId: 'ws_1', created: true })),
}));
vi.mock('../routes/onboard', () => ({
  pickNewOrgSlug: vi.fn(async () => 'acme-bv'),
  resolveUniqueSlug: vi.fn(async (_db: unknown, base: string) => base),
}));
vi.mock('./provisioning', () => ({ provisionWorkspaceDatabase: vi.fn(async () => ({ ok: true, ready: false })) }));
vi.mock('./mail-provisioning', () => ({ provisionMailDomain: vi.fn(async () => undefined) }));

import * as core from '@weldsuite/core-domain/partners';
import { provisionWorkspaceDatabase } from './provisioning';
import { ensurePartnerOwnerInvited, onboardPartnerWorkspace } from './partner-onboarding';
import type { Env } from '../index';

const env = {
  CLERK_SECRET_KEY: 'sk_test',
  NEON_API_KEY: 'neon',
  DATABASE_URL_MASTER: 'postgres://master',
} as unknown as Env;

const validInput = {
  partnerId: 'ptr_1',
  actorUserId: 'user_partner',
  name: 'Acme BV',
  country: 'br',
  region: 'aws-sa-east-1',
  ownerEmail: 'Owner@Acme.Example',
  licence: {
    allowedApps: ['weldcrm', 'welddesk'],
    monthlyCredits: 3000,
    creditRolloverCap: 0,
    maxSeats: 10,
    featurePlanId: 'plan_business',
    storageGb: null,
    resalePricing: { model: 'flat', amount: '199.00' },
    packageId: 'plp_1',
  },
};

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
let calls: Call[];
let invitations: Array<{ email_address: string }>;
let orgPrivateMetadata: Record<string, unknown>;

function stubClerk() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (method === 'POST' && url.endsWith('/organizations')) return json({ id: 'org_new', slug: 'acme-bv' });
      if (method === 'GET' && /\/organizations\/org_[a-z]+$/.test(url)) return json({ private_metadata: orgPrivateMetadata });
      if (method === 'GET' && url.includes('/invitations')) return json({ data: invitations });
      if (method === 'POST' && url.endsWith('/invitations')) return json({ id: 'orginv_1' });
      return json({});
    }),
  );
}

const clerkCall = (method: string, suffix: string) =>
  calls.find((c) => c.method === method && c.url.endsWith(suffix));

beforeEach(() => {
  vi.clearAllMocks();
  planRows.current = [{ id: 'plan_free' }];
  invitations = [];
  orgPrivateMetadata = { partnerOwnerInvite: { email: 'owner@acme.example', invitedByName: 'Acme Partner' } };
  stubClerk();
  vi.mocked(provisionWorkspaceDatabase).mockResolvedValue({ ok: true, ready: false });
  vi.mocked(core.findRecentPartnerWorkspace).mockResolvedValue(null);
});

describe('onboardPartnerWorkspace', () => {
  it('creates the Clerk org without a creator and returns the ids', async () => {
    const out = await onboardPartnerWorkspace(env, validInput);

    expect(out).toEqual({ workspaceId: 'ws_1', clerkOrgId: 'org_new' });
    const create = clerkCall('POST', '/organizations')!;
    // No `created_by`: the partner user must not become a member.
    expect(create.body).not.toHaveProperty('created_by');
    expect(create.body).toMatchObject({
      name: 'Acme BV',
      slug: 'acme-bv',
      // selectedApps present = created via onboarding (the webhook skips provisioning)
      public_metadata: { selectedApps: ['weldcrm', 'welddesk'], country: 'BR', partnerManaged: true },
      private_metadata: {
        partnerId: 'ptr_1',
        partnerOwnerInvite: { email: 'owner@acme.example', invitedByName: 'Acme Partner' },
      },
    });
  });

  it('registers the master rows with the licence, the actor and the default plan', async () => {
    await onboardPartnerWorkspace(env, validInput);
    expect(core.registerPartnerWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clerkOrgId: 'org_new',
        name: 'Acme BV',
        slug: 'acme-bv',
        partnerId: 'ptr_1',
        actorUserId: 'user_partner',
        defaultPlanId: 'plan_free',
        licence: expect.objectContaining({ allowedApps: ['weldcrm', 'welddesk'], packageId: 'plp_1' }),
      }),
    );
  });

  it('caps Clerk memberships at the licence\'s seats (and removes the cap when unlimited)', async () => {
    await onboardPartnerWorkspace(env, validInput);
    expect(clerkCall('PATCH', '/organizations/org_new')!.body).toEqual({ max_allowed_memberships: 10 });

    calls.length = 0;
    await onboardPartnerWorkspace(env, { ...validInput, licence: { ...validInput.licence, maxSeats: null } });
    expect(clerkCall('PATCH', '/organizations/org_new')!.body).toEqual({ max_allowed_memberships: null });
  });

  it('starts provisioning with the licensed apps, no initial member and no sample data', async () => {
    await onboardPartnerWorkspace(env, validInput);
    expect(provisionWorkspaceDatabase).toHaveBeenCalledTimes(1);
    const [, , workspaceId, name, options] = vi.mocked(provisionWorkspaceDatabase).mock.calls[0]!;
    expect(workspaceId).toBe('ws_1');
    expect(name).toBe('Acme BV');
    expect(options).toMatchObject({
      selectedApps: ['weldcrm', 'welddesk'],
      region: 'aws-sa-east-1',
      slug: 'acme-bv',
      seedSampleData: false,
    });
    expect(options).not.toHaveProperty('initialMember');
  });

  it('leaves the owner invitation to the workflow while the database is still being provisioned', async () => {
    await onboardPartnerWorkspace(env, validInput);
    expect(clerkCall('POST', '/invitations')).toBeUndefined();
  });

  it('invites the owner at once when the database is already usable', async () => {
    vi.mocked(provisionWorkspaceDatabase).mockResolvedValue({ ok: true, ready: true });
    await onboardPartnerWorkspace(env, validInput);

    const invite = clerkCall('POST', '/organizations/org_new/invitations')!;
    expect(invite.body).toEqual({
      email_address: 'owner@acme.example',
      role: 'org:admin',
      public_metadata: { weldRole: 'OWNER', invitedByName: 'Acme Partner' },
    });
    // the pending marker is cleared afterwards
    expect(clerkCall('PATCH', '/organizations/org_new/metadata')!.body).toEqual({
      private_metadata: { partnerOwnerInvite: null },
    });
  });

  it('never adds a member to the org', async () => {
    vi.mocked(provisionWorkspaceDatabase).mockResolvedValue({ ok: true, ready: true });
    await onboardPartnerWorkspace(env, validInput);
    expect(calls.some((c) => c.url.includes('/memberships'))).toBe(false);
  });

  it('rejects invalid input before anything is created', async () => {
    await expect(onboardPartnerWorkspace(env, { ...validInput, ownerEmail: 'nope' })).rejects.toThrow(/^\[VALIDATION\]/);
    await expect(onboardPartnerWorkspace(env, { ...validInput, country: 'BRA' })).rejects.toThrow(/^\[VALIDATION\]/);
    await expect(onboardPartnerWorkspace(env, null)).rejects.toThrow(/^\[VALIDATION\]/);
    expect(calls).toHaveLength(0);
    expect(core.registerPartnerWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a licence the contract does not allow, with its code, before touching Clerk', async () => {
    vi.mocked(core.assertPartnerOnboardAllowed).mockRejectedValueOnce(
      new core.LicenceError('INVALID_APPS', 'Unknown or unpublished apps: nope'),
    );
    await expect(onboardPartnerWorkspace(env, validInput)).rejects.toThrow(
      '[INVALID_APPS] Unknown or unpublished apps: nope',
    );
    expect(calls).toHaveLength(0);
    expect(core.registerPartnerWorkspace).not.toHaveBeenCalled();
  });

  it('resumes the workspace of an earlier attempt instead of creating a second org', async () => {
    vi.mocked(core.findRecentPartnerWorkspace).mockResolvedValue({ id: 'ws_1', clerkOrgId: 'org_old', slug: 'acme-bv' });
    const out = await onboardPartnerWorkspace(env, validInput);
    expect(out).toEqual({ workspaceId: 'ws_1', clerkOrgId: 'org_old' });
    expect(clerkCall('POST', '/organizations')).toBeUndefined();
    expect(provisionWorkspaceDatabase).toHaveBeenCalled();
  });

  it('marks the workspace failed and reports PROVISIONING_FAILED when provisioning cannot start', async () => {
    vi.mocked(provisionWorkspaceDatabase).mockResolvedValue({ ok: false, error: 'neon down' });
    await expect(onboardPartnerWorkspace(env, validInput)).rejects.toThrow('[PROVISIONING_FAILED] neon down');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ provisioningStatus: 'failed', provisioningError: 'neon down' }));
  });

  it('reports CLERK_ORG_FAILED when Clerk refuses the org', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errors":[{"code":"form_param_invalid"}]}', { status: 422 })));
    await expect(onboardPartnerWorkspace(env, validInput)).rejects.toThrow(/^\[CLERK_ORG_FAILED\]/);
    expect(core.registerPartnerWorkspace).not.toHaveBeenCalled();
  });

  it('retries a rejected slug with a suffix', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url.endsWith('/organizations')) {
          attempt++;
          if (attempt === 1) {
            return new Response(JSON.stringify({ errors: [{ meta: { param_name: 'slug' }, message: 'taken' }] }), { status: 422 });
          }
          return new Response(JSON.stringify({ id: 'org_new', slug: 'acme-bv-x1' }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }),
    );
    const out = await onboardPartnerWorkspace(env, validInput);
    expect(out.clerkOrgId).toBe('org_new');
    expect(attempt).toBe(2);
  });
});

describe('ensurePartnerOwnerInvited', () => {
  it('does nothing for an org without the pending-owner marker', async () => {
    orgPrivateMetadata = {};
    expect(await ensurePartnerOwnerInvited(env, 'org_new')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' || c.method === 'PATCH')).toBe(false);
  });

  it('is idempotent: an invitation already pending is not duplicated, the marker is still cleared', async () => {
    invitations = [{ email_address: 'OWNER@acme.example' }];
    expect(await ensurePartnerOwnerInvited(env, 'org_new')).toBe(false);
    expect(clerkCall('POST', '/invitations')).toBeUndefined();
    expect(clerkCall('PATCH', '/organizations/org_new/metadata')).toBeDefined();
  });

  it('leaves the marker in place when the invitation fails, so it can be retried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: null });
        if (method === 'GET' && /\/organizations\/org_[a-z]+$/.test(url)) {
          return new Response(JSON.stringify({ private_metadata: orgPrivateMetadata }), { status: 200 });
        }
        if (method === 'GET') return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response('{"errors":[]}', { status: 422 });
      }),
    );
    await expect(ensurePartnerOwnerInvited(env, 'org_new')).rejects.toThrow(/^\[INVITE_FAILED\]/);
    expect(clerkCall('PATCH', '/organizations/org_new/metadata')).toBeUndefined();
  });
});
