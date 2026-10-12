'use server';

import { revalidatePath } from 'next/cache';
import {
  attachWorkspaceSchema,
  createPartnerSchema,
  detachWorkspaceSchema,
  partnerContractSchema,
  partnerMemberInviteSchema,
  partnerProfileSchema,
  partnerStatusOverrideSchema,
  partnerTerritoriesSchema,
  workspaceLicenceInputSchema,
  type PartnerStatementView,
} from '@weldsuite/app-api-client/schemas/partners';
import { z } from 'zod';
import { getAdminIdentity, guardWrite } from '@/lib/auth';
import { callBillingWorker } from '@/lib/billing-worker';
import { isPeriod, zodMessage, type AdminLicence, type AdminPartnerMember, type AdminPartnerRecord } from '@/lib/partners';
import { listWorkspaces } from '@/lib/workspaces-data';
import type { ActionResult } from './workspaces';

/**
 * Partner (reseller) changes from the admin console. Each one is validated
 * with the shared schemas, performed and audited by the billing worker
 * (`/api/internal/admin/partners/*`, x-admin-secret) and then revalidated here.
 * The forms send the raw values; the schemas apply defaults and transforms.
 *
 * `requestId` is created once per submission on the client and forwarded as
 * `x-request-id`, so a retry after a timeout replays instead of repeating the
 * Stripe work (customer, invoice, void).
 */

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ID = z.string().trim().min(1).max(255);

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function refresh(partnerId?: string) {
  revalidatePath('/partners');
  if (partnerId) revalidatePath(`/partners/${partnerId}`);
  revalidatePath('/activity');
}

async function partnerWrite<T>(
  method: Method,
  path: string,
  body: unknown,
  requestId: string,
  partnerId?: string,
): Promise<ActionResult<T>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: 'Invalid request id.' };

  const result = await callBillingWorker<T>(method, path, { identity: guard.identity, body, requestId });
  refresh(partnerId);
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: result.error, code: result.code, details: result.details };
}

const base = (partnerId: string) => `/partners/${encodeURIComponent(partnerId)}`;

function invalid(error: z.ZodError): ActionResult<never> {
  return { ok: false, error: zodMessage(error), code: 'VALIDATION' };
}

// ---------------------------------------------------------------------------
// Partner
// ---------------------------------------------------------------------------

export async function createPartner(
  input: {
    profile: Record<string, unknown>;
    ownerEmail: string;
    contract: Record<string, unknown>;
    territories: string[];
  },
  requestId: string,
): Promise<ActionResult<AdminPartnerRecord>> {
  const parsed = createPartnerSchema.safeParse({
    ...input.profile,
    ownerEmail: input.ownerEmail,
    contract: input.contract,
    territories: input.territories,
  });
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<AdminPartnerRecord>('POST', '/partners', parsed.data, requestId);
}

export async function updatePartnerProfile(
  partnerId: string,
  profile: Record<string, unknown>,
  requestId: string,
): Promise<ActionResult<AdminPartnerRecord>> {
  const parsed = partnerProfileSchema.partial().safeParse(profile);
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<AdminPartnerRecord>('PATCH', base(partnerId), parsed.data, requestId, partnerId);
}

/** A new effective-dated contract; the worker closes the previous one at `effectiveFrom`. */
export async function createPartnerContract(
  partnerId: string,
  contract: Record<string, unknown>,
  requestId: string,
): Promise<ActionResult<{ id: string }>> {
  const parsed = partnerContractSchema.safeParse(contract);
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<{ id: string }>('POST', `${base(partnerId)}/contracts`, parsed.data, requestId, partnerId);
}

/**
 * Replace the partner's territory list. A country already owned by another
 * partner comes back as `code: 'TERRITORY_CONFLICT'` with `details.countries`.
 */
export async function savePartnerTerritories(
  partnerId: string,
  countries: string[],
  requestId: string,
): Promise<ActionResult<string[]>> {
  const parsed = partnerTerritoriesSchema.safeParse({ countries });
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<string[]>('PUT', `${base(partnerId)}/territories`, parsed.data, requestId, partnerId);
}

export async function invitePartnerMember(
  partnerId: string,
  input: { email: string; role: string },
  requestId: string,
): Promise<ActionResult<AdminPartnerMember>> {
  const parsed = partnerMemberInviteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<AdminPartnerMember>('POST', `${base(partnerId)}/members`, parsed.data, requestId, partnerId);
}

export async function removePartnerMember(
  partnerId: string,
  memberId: string,
  requestId: string,
): Promise<ActionResult<undefined>> {
  const id = ID.safeParse(memberId);
  if (!id.success) return invalid(id.error);
  return partnerWrite<undefined>('DELETE', `${base(partnerId)}/members/${encodeURIComponent(id.data)}`, undefined, requestId, partnerId);
}

/** Set the payment status and/or pause (or clear the pause of) the dunning clock. */
export async function overridePartnerStatus(
  partnerId: string,
  input: { status?: string; dunningPausedUntil?: string | null; reason: string },
  requestId: string,
): Promise<ActionResult<AdminPartnerRecord>> {
  const parsed = partnerStatusOverrideSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (parsed.data.status === undefined && parsed.data.dunningPausedUntil === undefined) {
    return { ok: false, error: 'Nothing to change.', code: 'VALIDATION' };
  }
  return partnerWrite<AdminPartnerRecord>('POST', `${base(partnerId)}/status`, parsed.data, requestId, partnerId);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** Move an existing direct workspace under the partner (cancels its direct subscription). */
export async function attachPartnerWorkspace(
  partnerId: string,
  input: Record<string, unknown>,
  requestId: string,
): Promise<ActionResult<{ workspaceId: string }>> {
  const parsed = attachWorkspaceSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<{ workspaceId: string }>('POST', `${base(partnerId)}/workspaces/attach`, parsed.data, requestId, partnerId);
}

/** End the licence and put the workspace back to direct billing. Data is kept. */
export async function detachPartnerWorkspace(
  partnerId: string,
  workspaceId: string,
  input: { reason: string },
  requestId: string,
): Promise<ActionResult<{ workspaceId: string }>> {
  const parsed = detachWorkspaceSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<{ workspaceId: string }>(
    'POST',
    `${base(partnerId)}/workspaces/${encodeURIComponent(workspaceId)}/detach`,
    parsed.data,
    requestId,
    partnerId,
  );
}

/** Admin override of a managed workspace's licence. */
export async function updatePartnerWorkspaceLicence(
  partnerId: string,
  workspaceId: string,
  input: Record<string, unknown>,
  requestId: string,
): Promise<ActionResult<AdminLicence>> {
  const parsed = workspaceLicenceInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return partnerWrite<AdminLicence>(
    'PUT',
    `${base(partnerId)}/workspaces/${encodeURIComponent(workspaceId)}/licence`,
    parsed.data,
    requestId,
    partnerId,
  );
}

/** Workspace lookup for the attach form (name or slug). Read-only, so viewers may use it. */
export async function searchWorkspacesToAttach(
  query: string,
): Promise<ActionResult<Array<{ id: string; name: string; slug: string }>>> {
  const identity = await getAdminIdentity();
  if (!identity) return { ok: false, error: 'Not authorized' };
  const search = query.trim();
  if (search.length < 2) return { ok: true, data: [] };
  const rows = await listWorkspaces({ search });
  return {
    ok: true,
    data: rows
      .filter((w) => w.deletionState !== 'deleted')
      .slice(0, 8)
      .map((w) => ({ id: w.id, name: w.name, slug: w.slug })),
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const periodQuery = (period: string): string | null => (isPeriod(period) ? `?period=${period}` : null);

/** Live calculation of one month; saves nothing. Read-only, so viewers may preview. */
export async function previewPartnerStatement(
  partnerId: string,
  period: string,
): Promise<ActionResult<PartnerStatementView>> {
  const identity = await getAdminIdentity();
  if (!identity) return { ok: false, error: 'Not authorized' };
  const query = periodQuery(period);
  if (!query) return { ok: false, error: 'period: use YYYY-MM', code: 'VALIDATION' };
  const result = await callBillingWorker<PartnerStatementView>('GET', `${base(partnerId)}/statements/preview${query}`, { identity });
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, code: result.code };
}

/** A saved statement with its lines. */
export async function getPartnerStatement(
  partnerId: string,
  statementId: string,
): Promise<ActionResult<PartnerStatementView>> {
  const identity = await getAdminIdentity();
  if (!identity) return { ok: false, error: 'Not authorized' };
  const id = ID.safeParse(statementId);
  if (!id.success) return invalid(id.error);
  const result = await callBillingWorker<PartnerStatementView>(
    'GET',
    `${base(partnerId)}/statements/${encodeURIComponent(id.data)}`,
    { identity },
  );
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, code: result.code };
}

/** Re-build a month's statement and invoice it (a draft or final statement; not a paid or void one). */
export async function runPartnerStatement(
  partnerId: string,
  period: string,
  requestId: string,
): Promise<ActionResult<PartnerStatementView>> {
  const query = periodQuery(period);
  if (!query) return { ok: false, error: 'period: use YYYY-MM', code: 'VALIDATION' };
  return partnerWrite<PartnerStatementView>('POST', `${base(partnerId)}/statements/run${query}`, undefined, requestId, partnerId);
}

export async function voidPartnerStatement(
  partnerId: string,
  statementId: string,
  input: { reason: string },
  requestId: string,
): Promise<ActionResult<PartnerStatementView>> {
  const parsed = z.object({ reason: z.string().trim().min(1).max(1000) }).safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const id = ID.safeParse(statementId);
  if (!id.success) return invalid(id.error);
  return partnerWrite<PartnerStatementView>(
    'POST',
    `${base(partnerId)}/statements/${encodeURIComponent(id.data)}/void`,
    parsed.data,
    requestId,
    partnerId,
  );
}
