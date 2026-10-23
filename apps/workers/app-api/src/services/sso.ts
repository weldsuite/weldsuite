/**
 * Enterprise SSO configuration of a workspace (routes/sso): the domain and its
 * DNS proof of ownership, the Clerk SAML connection, and switching it on or
 * off. Entitlement and Clerk's `active` flag come from
 * `@weldsuite/core-domain/sso`, which billing-worker shares for the add-on.
 *
 * Order of a setup: claim the domain → add the TXT record → verify → (be
 * entitled) → create the connection (Clerk returns the ACS URL and entity id
 * to enter in the IdP) → add the IdP's metadata → activate.
 *
 * Why the domain proof: Clerk sends every user whose email is at the
 * connection's domain to that connection's IdP, existing accounts included.
 * Without proof, a workspace could claim someone else's domain and sign in as
 * their users through an IdP it controls.
 */

import { and, eq, isNotNull, isNull, ne, type SQL } from 'drizzle-orm';
import { masterSchema } from '@weldsuite/worker-kit/db';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { WorkspaceSso } from '@weldsuite/db/schema/master';
import {
  SSO_ERRORS,
  isIdpConfigured,
  isPublicEmailDomain,
  normalizeSsoDomain,
  ssoDnsRecordMatches,
  ssoDnsRecordName,
  ssoDnsRecordValue,
  type SsoConfigView,
  type SsoConnectionInput,
} from '@weldsuite/app-api-client/schemas/sso';
import {
  CLEARED_CONNECTION,
  clerkErrorMessage,
  clerkErrorStatus,
  deleteSsoConnection,
  ensureSsoRow,
  loadSsoContext,
  reconcileSsoConnection,
  ssoEntitlement,
  updateSsoRow,
  type ClerkSamlConnection,
  type ClerkSamlConnectionParams,
  type SsoClerkClient,
  type SsoContext,
  type SsoDb,
} from '@weldsuite/core-domain/sso';

const { workspaceSso } = masterSchema;

type SsoErrorStatus = 400 | 402 | 403 | 404 | 409 | 422 | 502 | 503;

/** A refusal the route turns into `{ error: { code, message } }` with `status`. */
export class SsoError extends Error {
  constructor(
    readonly status: SsoErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

export async function loadContext(db: SsoDb, clerkOrgId: string): Promise<SsoContext> {
  const ctx = await loadSsoContext(db, { clerkOrgId });
  if (!ctx) throw new SsoError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');
  return ctx;
}

/** 32 hex characters for the TXT record. */
function verificationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function changedMeanwhile(): SsoError {
  return new SsoError(409, SSO_ERRORS.CHANGED_MEANWHILE, 'Single sign-on was changed by another request. Reload and try again.');
}

/**
 * `updateSsoRow` that lands only while the row still holds what the caller
 * checked before a slow step (the DNS lookup, a Clerk call); `null` when
 * another request changed it in between. Without this, verifying `a.com`
 * while the domain is swapped to `b.com` would stamp `b.com` as verified.
 */
async function updateCheckedSsoRow(
  db: SsoDb,
  rowId: string,
  checked: SQL[],
  patch: Partial<Omit<WorkspaceSso, 'id' | 'workspaceId' | 'createdAt'>>,
): Promise<WorkspaceSso | null> {
  const [row] = await db
    .update(workspaceSso)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(workspaceSso.id, rowId), ...checked))
    .returning();
  return row ?? null;
}

function sameConnection(connectionId: string | null): SQL {
  return connectionId ? eq(workspaceSso.clerkConnectionId, connectionId) : isNull(workspaceSso.clerkConnectionId);
}

function clerkFailure(err: unknown): SsoError {
  const status = clerkErrorStatus(err);
  if (status === 400 || status === 422) {
    return new SsoError(
      422,
      SSO_ERRORS.IDP_REJECTED,
      clerkErrorMessage(err) ?? 'The identity provider details were not accepted. Check them and try again.',
    );
  }
  console.error('[SSO] Clerk request failed:', err);
  return new SsoError(
    status === 402 || status === 403 ? 503 : 502,
    SSO_ERRORS.PROVIDER_UNAVAILABLE,
    'Single sign-on could not be updated right now. Try again later.',
  );
}

// ============================================================================
// View
// ============================================================================

async function liveConnection(clerk: SsoClerkClient | null, row: WorkspaceSso): Promise<ClerkSamlConnection | null> {
  if (!clerk || !row.clerkConnectionId) return null;
  try {
    return await clerk.samlConnections.getSamlConnection(row.clerkConnectionId);
  } catch (err) {
    console.warn(`[SSO] Reading connection ${row.clerkConnectionId} failed:`, err);
    return null;
  }
}

type IdpView = NonNullable<SsoConfigView['connection']>['idp'];

function idpOf(connection: ClerkSamlConnection | null): IdpView {
  return {
    metadataUrl: connection?.idpMetadataUrl || null,
    hasMetadata: Boolean(connection?.idpMetadata),
    entityId: connection?.idpEntityId || null,
    ssoUrl: connection?.idpSsoUrl || null,
    hasCertificate: Boolean(connection?.idpCertificate),
  };
}

export async function buildSsoView(clerk: SsoClerkClient | null, ctx: SsoContext, canManage: boolean): Promise<SsoConfigView> {
  const row = ctx.row;
  const live = row ? await liveConnection(clerk, row) : null;
  const idp = idpOf(live);

  return {
    entitlement: ssoEntitlement(ctx),
    domain:
      row?.domain && row.domainVerificationToken
        ? {
            name: row.domain,
            verified: Boolean(row.domainVerifiedAt),
            verifiedAt: row.domainVerifiedAt?.toISOString() ?? null,
            dnsRecord: { type: 'TXT', name: ssoDnsRecordName(row.domain), value: ssoDnsRecordValue(row.domainVerificationToken) },
          }
        : null,
    connection:
      row?.clerkConnectionId && row.provider
        ? {
            provider: row.provider,
            enabled: row.enabled,
            active: row.clerkActive,
            idp,
            idpConfigured: isIdpConfigured(idp),
            sp: {
              acsUrl: live?.acsUrl ?? row.acsUrl,
              entityId: live?.spEntityId ?? row.spEntityId,
              metadataUrl: live?.spMetadataUrl ?? row.spMetadataUrl,
            },
            userCount: live ? live.userCount : null,
            updatedAt: row.connectionUpdatedAt?.toISOString() ?? null,
          }
        : null,
    canManage,
  };
}

// ============================================================================
// Domain
// ============================================================================

/** Claim a domain. The same domain again keeps its token; another one starts over. */
export async function setSsoDomain(db: SsoDb, ctx: SsoContext, input: string, actor: string): Promise<void> {
  const domain = normalizeSsoDomain(input);
  if (!domain) throw new SsoError(400, SSO_ERRORS.DOMAIN_INVALID, 'Enter a domain like acme.com.');
  if (isPublicEmailDomain(domain)) {
    throw new SsoError(400, SSO_ERRORS.DOMAIN_PUBLIC, 'Use your company domain, not a public email provider.');
  }

  const row = ctx.row ?? (await ensureSsoRow(db, ctx.workspace));
  if (row.domain === domain) return;
  if (row.clerkConnectionId) {
    throw new SsoError(409, SSO_ERRORS.DOMAIN_LOCKED, 'Remove the identity provider connection before changing the domain.');
  }
  await assertDomainFree(db, domain, ctx.workspace.id);

  const saved = await updateCheckedSsoRow(db, row.id, [sameConnection(null)], {
    domain,
    domainVerificationToken: verificationToken(),
    domainVerifiedAt: null,
    connectionUpdatedBy: actor,
    connectionUpdatedAt: new Date(),
  });
  if (!saved) throw changedMeanwhile();
}

async function assertDomainFree(db: SsoDb, domain: string, workspaceId: string): Promise<void> {
  const [taken] = await db
    .select({ id: workspaceSso.id })
    .from(workspaceSso)
    .where(and(eq(workspaceSso.domain, domain), isNotNull(workspaceSso.domainVerifiedAt), ne(workspaceSso.workspaceId, workspaceId)))
    .limit(1);
  if (taken) {
    throw new SsoError(409, SSO_ERRORS.DOMAIN_IN_USE, 'Another workspace already uses this domain for single sign-on.');
  }
}

export async function removeSsoDomain(db: SsoDb, ctx: SsoContext, actor: string): Promise<void> {
  const row = ctx.row;
  if (!row?.domain) return;
  if (row.clerkConnectionId) {
    throw new SsoError(409, SSO_ERRORS.DOMAIN_LOCKED, 'Remove the identity provider connection before removing the domain.');
  }
  const saved = await updateCheckedSsoRow(db, row.id, [sameConnection(null)], {
    domain: null,
    domainVerificationToken: null,
    domainVerifiedAt: null,
    connectionUpdatedBy: actor,
    connectionUpdatedAt: new Date(),
  });
  if (!saved) throw changedMeanwhile();
}

/** Look for the TXT record; on a match the domain is the workspace's. */
export async function verifySsoDomain(
  db: SsoDb,
  ctx: SsoContext,
  lookupTxt: (name: string) => Promise<string[]>,
  actor: string,
): Promise<void> {
  const row = ctx.row;
  if (!row?.domain || !row.domainVerificationToken) {
    throw new SsoError(409, SSO_ERRORS.DOMAIN_MISSING, 'Add your domain first.');
  }
  if (row.domainVerifiedAt) return;

  let values: string[];
  try {
    values = await lookupTxt(ssoDnsRecordName(row.domain));
  } catch (err) {
    console.warn(`[SSO] TXT lookup for ${row.domain} failed:`, err);
    throw new SsoError(502, SSO_ERRORS.DNS_LOOKUP_FAILED, 'The DNS lookup failed. Try again in a minute.');
  }
  if (!ssoDnsRecordMatches(values, row.domainVerificationToken)) {
    throw new SsoError(
      422,
      SSO_ERRORS.DOMAIN_NOT_VERIFIED,
      'The TXT record was not found yet. DNS changes can take a while to show up; try again later.',
    );
  }

  await assertDomainFree(db, row.domain, ctx.workspace.id);
  let verified: WorkspaceSso | null;
  try {
    // Only the claim whose record was looked up: the token is new on every
    // claim, so a domain changed during the lookup no longer matches.
    verified = await updateCheckedSsoRow(
      db,
      row.id,
      [eq(workspaceSso.domain, row.domain), eq(workspaceSso.domainVerificationToken, row.domainVerificationToken)],
      { domainVerifiedAt: new Date(), connectionUpdatedBy: actor, connectionUpdatedAt: new Date() },
    );
  } catch (err) {
    // Another workspace verified the same domain a moment earlier.
    if (isUniqueViolation(err)) {
      throw new SsoError(409, SSO_ERRORS.DOMAIN_IN_USE, 'Another workspace already uses this domain for single sign-on.');
    }
    throw err;
  }
  if (!verified) throw changedMeanwhile();
}

// ============================================================================
// Connection
// ============================================================================

/** IdP fields for Clerk: absent = leave alone, null = clear (Clerk clears on an empty string). */
function idpParams(input: SsoConnectionInput, forCreate: boolean): ClerkSamlConnectionParams {
  const params: ClerkSamlConnectionParams = {};
  const fields = [
    ['idpMetadataUrl', input.idpMetadataUrl],
    ['idpMetadata', input.idpMetadata],
    ['idpEntityId', input.idpEntityId],
    ['idpSsoUrl', input.idpSsoUrl],
    ['idpCertificate', input.idpCertificate],
  ] as const;
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    if (value === null || value === '') {
      if (!forCreate) params[key] = '';
      continue;
    }
    params[key] = value;
  }
  return params;
}

function requireEntitled(ctx: SsoContext): void {
  if (!ssoEntitlement(ctx).entitled) {
    throw new SsoError(402, SSO_ERRORS.NOT_ENTITLED, 'Add single sign-on to your workspace first.');
  }
}

/** Create the connection, or update its provider and IdP details. */
export async function saveSsoConnection(
  db: SsoDb,
  clerk: SsoClerkClient,
  ctx: SsoContext,
  input: SsoConnectionInput,
  actor: string,
): Promise<void> {
  requireEntitled(ctx);
  let row = ctx.row;
  if (!row?.domain || !row.domainVerifiedAt) {
    throw new SsoError(409, SSO_ERRORS.DOMAIN_NOT_VERIFIED, 'Verify your domain first.');
  }

  if (row.clerkConnectionId) {
    const connectionId = row.clerkConnectionId;
    let gone = false;
    try {
      await clerk.samlConnections.updateSamlConnection(connectionId, {
        provider: input.provider,
        ...idpParams(input, false),
      });
    } catch (err) {
      if (clerkErrorStatus(err) !== 404) throw clerkFailure(err);
      gone = true;
    }
    if (!gone) {
      const saved = await updateCheckedSsoRow(db, row.id, [sameConnection(connectionId)], {
        provider: input.provider,
        connectionUpdatedBy: actor,
        connectionUpdatedAt: new Date(),
      });
      if (!saved) throw changedMeanwhile();
      return;
    }
    // Deleted in Clerk's dashboard: start a new one below.
    const cleared = await updateCheckedSsoRow(db, row.id, [sameConnection(connectionId)], { ...CLEARED_CONNECTION });
    if (!cleared) throw changedMeanwhile();
    row = cleared;
  }

  const domain = row.domain;
  if (!domain) throw new SsoError(409, SSO_ERRORS.DOMAIN_NOT_VERIFIED, 'Verify your domain first.');
  let created: ClerkSamlConnection;
  try {
    created = await clerk.samlConnections.createSamlConnection({
      name: `${ctx.workspace.name} SSO`.slice(0, 100),
      provider: input.provider,
      domain,
      organizationId: row.clerkOrgId,
      ...idpParams(input, true),
    });
  } catch (err) {
    throw clerkFailure(err);
  }

  // Keep the connection only if the row still holds the verified domain it
  // was created for, and no other request created one meanwhile.
  const saved = await updateCheckedSsoRow(
    db,
    row.id,
    [eq(workspaceSso.domain, domain), isNotNull(workspaceSso.domainVerifiedAt), sameConnection(null)],
    {
      clerkConnectionId: created.id,
      provider: input.provider,
      enabled: false,
      clerkActive: created.active,
      acsUrl: created.acsUrl,
      spEntityId: created.spEntityId,
      spMetadataUrl: created.spMetadataUrl,
      connectionUpdatedBy: actor,
      connectionUpdatedAt: new Date(),
    },
  );
  if (!saved) {
    try {
      await clerk.samlConnections.deleteSamlConnection(created.id);
    } catch (err) {
      console.error(`[SSO] Removing unused connection ${created.id} failed:`, err);
    }
    throw changedMeanwhile();
  }

  // Clerk may create it active; nothing is switched on until the admin says so.
  if (created.active) {
    const fresh = await loadSsoContext(db, { workspaceId: ctx.workspace.id });
    if (fresh) await reconcileSsoConnection(db, clerk, fresh, actor);
  }
}

export async function removeSsoConnection(db: SsoDb, clerk: SsoClerkClient, ctx: SsoContext, actor: string): Promise<void> {
  if (!ctx.row?.clerkConnectionId) return;
  try {
    await deleteSsoConnection(db, clerk, ctx.row, actor);
  } catch (err) {
    throw clerkFailure(err);
  }
}

/** Switch SSO on or off. On needs entitlement, a verified domain and a complete IdP. */
export async function setSsoEnabled(
  db: SsoDb,
  clerk: SsoClerkClient,
  ctx: SsoContext,
  enabled: boolean,
  actor: string,
): Promise<void> {
  const row = ctx.row;
  if (!row?.clerkConnectionId) {
    throw new SsoError(409, SSO_ERRORS.CONNECTION_MISSING, 'Connect your identity provider first.');
  }

  const checked = [sameConnection(row.clerkConnectionId)];
  if (enabled) {
    requireEntitled(ctx);
    if (!row.domain || !row.domainVerifiedAt) {
      throw new SsoError(409, SSO_ERRORS.DOMAIN_NOT_VERIFIED, 'Verify your domain first.');
    }
    checked.push(eq(workspaceSso.domain, row.domain), isNotNull(workspaceSso.domainVerifiedAt));
    let live: ClerkSamlConnection;
    try {
      live = await clerk.samlConnections.getSamlConnection(row.clerkConnectionId);
    } catch (err) {
      throw clerkFailure(err);
    }
    if (!isIdpConfigured(idpOf(live))) {
      throw new SsoError(
        409,
        SSO_ERRORS.IDP_INCOMPLETE,
        "Add your identity provider's metadata URL, or its entity ID, sign-on URL and certificate.",
      );
    }
  }

  const saved = await updateCheckedSsoRow(db, row.id, checked, { enabled, connectionUpdatedBy: actor, connectionUpdatedAt: new Date() });
  if (!saved) throw changedMeanwhile();
  try {
    await reconcileSsoConnection(db, clerk, { ...ctx, row: saved }, actor);
  } catch (err) {
    // Put the switch back so the page does not claim a state Clerk is not in.
    await updateSsoRow(db, row.id, { enabled: row.enabled });
    throw clerkFailure(err);
  }
}
