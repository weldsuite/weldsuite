/**
 * App access requests — /api/app-catalog/:code/access-request.
 *
 * Apps with `app_catalog.requires_approval` (WeldReach first) cannot be
 * installed until WeldSuite staff approve the workspace. The workspace
 * OWNER/ADMIN files the request here, from the app store; staff review it in
 * the admin console (master `workspace_app_access`) and the module worker
 * refuses every request until it is approved. This lives in app-api, the core
 * app store, because the module worker itself is closed until approval.
 *
 * Surface (mounted on the same prefix as the catalog routes):
 *   - GET  /:code/access-request — the workspace's request, or `data: null`
 *   - POST /:code/access-request — file it (OWNER/ADMIN only); filed again
 *     after a rejection or revocation, 409 APP_ACCESS_EXISTS otherwise
 *
 * Reads are open to every authenticated member, like the rest of the catalog.
 * The write is role-gated on the tenant `workspaceMembers` row, exactly like
 * install (`isAdminOrOwner`), instead of a `requirePermission` key.
 *
 * Staff notes are never returned (`toAppAccessView`). A new request emails
 * `ACCESS_REQUEST_NOTIFY_EMAIL` (best effort) and drops the 60 s KV access
 * cache of the workspace so the module worker sees the new status at once.
 *
 * Entity events: none. The events catalog has no fitting type, and this is
 * master-DB commercial data like partner licences or credits, not a tenant
 * entity that workflows, analytics or agents should see.
 */

import { Hono } from 'hono';
import { appAccessRequestInputSchema } from '@weldsuite/app-api-client/schemas/reach';
import { appNotLicensedBody } from '@weldsuite/api-modules';
import { appAccessCacheKey } from '@weldsuite/worker-kit/app-access';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error, success } from '@weldsuite/worker-kit/response';
import { isAdminOrOwner } from '@weldsuite/mail-domain/access';
import { toDbCode } from '../../lib/legacy-app-codes';
import {
  getAppAccessView,
  isRequestableApp,
  requestAppAccess,
  toAppAccessView,
  validateTerms,
} from '../../services/app-access';
import { notifyAccessRequested } from '../../services/app-access-notify';
import { getManagedContext } from '../../services/partner/managed';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET /:code/access-request — the workspace's own request
// ============================================================================

app.get('/:code/access-request', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const appCode = toDbCode(c.req.param('code'));

  const view = await getAppAccessView(getMasterDb(c.env), orgId, appCode);
  return success(c, view);
});

// ============================================================================
// POST /:code/access-request — ask for access (OWNER/ADMIN)
// ============================================================================

app.post('/:code/access-request', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const appCode = toDbCode(c.req.param('code'));
  const userId = c.get('userId');
  const masterDb = getMasterDb(c.env);

  const isAdmin = await isAdminOrOwner(c.get('tenantDb'), userId);
  if (!isAdmin) {
    return error.forbidden(c, 'Only workspace admins can request access to an app');
  }

  if (!(await isRequestableApp(masterDb, appCode))) return error.notFound(c, 'App', appCode);

  // A partner-managed workspace gets only the apps its licence lists, so a
  // request for another one could never be put to use (same rule as install).
  const managed = await getManagedContext(masterDb, orgId);
  if (managed && !managed.licence?.allowedApps.includes(appCode)) {
    return c.json(appNotLicensedBody(appCode), 403);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return error.badRequest(c, 'Invalid JSON body');
  }
  const parsed = appAccessRequestInputSchema.safeParse(json);
  if (!parsed.success) {
    return error.badRequest(c, 'Invalid access request', parsed.error.flatten());
  }
  const input = parsed.data;

  const termsProblem = validateTerms(appCode, input);
  if (termsProblem) return error.badRequest(c, termsProblem);

  const result = await requestAppAccess({ masterDb, clerkOrgId: orgId, appCode, userId, input });
  if (!result.ok) {
    if (result.reason === 'workspace_not_found') return error.notFound(c, 'Workspace');
    return c.json(
      {
        error: {
          code: 'APP_ACCESS_EXISTS',
          message: `Access to ${appCode} is already ${result.status}.`,
          details: { appCode, status: result.status },
        },
      },
      409,
    );
  }

  // The module worker caches the status for 60 s; drop it so a re-request
  // after a rejection is not hidden behind the old answer.
  try {
    await c.env.WORKSPACE_CACHE.delete(appAccessCacheKey(orgId, appCode));
  } catch (err) {
    console.warn('[app-access] KV cache delete failed:', err);
  }

  c.executionCtx.waitUntil(
    notifyAccessRequested(c.env, {
      appCode,
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      input,
    }),
  );

  return success(c, toAppAccessView(result.access), 201);
});

export const appAccessRoutes = app;
