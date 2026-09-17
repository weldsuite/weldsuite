/**
 * CLI device-code login — /api/cli-auth/*.
 *
 *   POST /device   — public: start a pending session, return user + device codes
 *   POST /token    — public: CLI polls until the key is minted (one-shot)
 *   POST /approve  — Clerk + org: developer portal confirms and mints a personal wsk_
 *
 * Mounted ABOVE the global /api/* workspaceDb guard so /device and /token stay
 * public. /approve applies clerk + workspace middleware itself.
 *
 * No entity events — credentials are infra (same exemption as api-keys).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createClerkClient } from '@clerk/backend';
import type { Env, Variables } from '../../types';
import { clerkMiddleware } from '../../middleware/clerk';
import { workspaceDbMiddleware } from '../../middleware/workspace-db';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, schema } from '../../db';
import { generateApiKey, registerApiKey, unregisterApiKey } from '../../services/api-keys';
import {
  CLI_AUTH_POLL_INTERVAL_SECONDS,
  CLI_AUTH_TTL_SECONDS,
  CLI_KEY_NAME,
  CLI_KEY_SCOPES,
  defaultExternalApiUrl,
  deleteCliAuthSession,
  formatUserCode,
  generateDeviceCode,
  generateUserCode,
  getCliAuthByDevice,
  getCliAuthByUserCode,
  normalizeUserCode,
  putCliAuthSession,
  resolveLoginUrl,
  type CliAuthComplete,
} from '../../services/cli-auth';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const startDeviceInput = z.object({
  loginUrl: z.string().url().optional(),
});

const tokenInput = z.object({
  deviceCode: z.string().min(16).max(128),
});

const approveInput = z.object({
  userCode: z.string().min(4).max(32),
});

/** POST /device — begin a CLI login session. */
app.post('/device', zValidator('json', startDeviceInput), async (c) => {
  const { loginUrl: requestedLoginUrl } = c.req.valid('json');
  const loginUrl = resolveLoginUrl(requestedLoginUrl, c.env.ENVIRONMENT);
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const displayCode = formatUserCode(userCode);

  await putCliAuthSession(c.env.WORKSPACE_CACHE, {
    status: 'pending',
    deviceCode,
    userCode,
    createdAt: Date.now(),
  });

  const verificationUri = `${loginUrl}/cli-auth`;
  const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(displayCode)}`;

  return success(c, {
    deviceCode,
    userCode: displayCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: CLI_AUTH_TTL_SECONDS,
    interval: CLI_AUTH_POLL_INTERVAL_SECONDS,
  });
});

/**
 * POST /token — CLI polls. Returns pending | complete (consumes the session)
 * | expired.
 */
app.post('/token', zValidator('json', tokenInput), async (c) => {
  const { deviceCode } = c.req.valid('json');
  const session = await getCliAuthByDevice(c.env.WORKSPACE_CACHE, deviceCode);

  if (!session) {
    return error.badRequest(c, 'Device code expired or unknown. Run weld login again.');
  }

  if (session.status === 'pending') {
    return success(c, {
      status: 'pending' as const,
      interval: CLI_AUTH_POLL_INTERVAL_SECONDS,
    });
  }

  // One-shot: delete before returning so a second poll cannot re-read the key.
  await deleteCliAuthSession(c.env.WORKSPACE_CACHE, session);

  return success(c, {
    status: 'complete' as const,
    apiKey: session.apiKey,
    keyId: session.keyId,
    keyPrefix: session.keyPrefix,
    orgId: session.orgId,
    orgName: session.orgName,
    userId: session.userId,
    email: session.email,
    apiUrl: session.apiUrl,
  });
});

/** Approve sub-router: needs Clerk session + active org (tenant DB). */
const approve = new Hono<{ Bindings: Env; Variables: Variables }>();
approve.use('*', clerkMiddleware(), workspaceDbMiddleware());

approve.post('/', zValidator('json', approveInput), async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (!userId || !orgId) return error.unauthorized(c);

  const rawCode = c.req.valid('json').userCode;
  const session = await getCliAuthByUserCode(c.env.WORKSPACE_CACHE, rawCode);
  if (!session) {
    return error.badRequest(c, 'Code expired or unknown. Run weld login again in the terminal.');
  }
  if (session.status === 'complete') {
    return success(c, { status: 'complete' as const, alreadyApproved: true });
  }

  const db = c.get('tenantDb');
  const t = schema.apiKeys;

  try {
    // Soft-revoke prior Weld CLI keys for this user to avoid key sprawl.
    const existing = await db
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), eq(t.name, CLI_KEY_NAME), isNull(t.deletedAt)));

    for (const row of existing) {
      await db
        .update(t)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(t.id, row.id), eq(t.userId, userId)));
      await unregisterApiKey(getMasterDb(c.env), row.id);
    }

    const { key, hash, prefix } = await generateApiKey();
    const id = generateId('ak');
    const now = new Date();
    const scopes = [...CLI_KEY_SCOPES];

    await db.insert(t).values({
      id,
      userId,
      name: CLI_KEY_NAME,
      description: 'Minted by weld login (device code)',
      keyHash: hash,
      keyPrefix: prefix,
      scopes,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await registerApiKey({
      masterDb: getMasterDb(c.env),
      clerkOrgId: orgId,
      keyHash: hash,
      keyType: 'personal',
      tenantKeyId: id,
    });

    let email: string | null = null;
    let orgName: string | null = null;
    try {
      const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
      const [user, org] = await Promise.all([
        clerk.users.getUser(userId),
        clerk.organizations.getOrganization({ organizationId: orgId }),
      ]);
      email =
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
        user.emailAddresses[0]?.emailAddress ??
        null;
      orgName = org.name ?? null;
    } catch (err) {
      console.warn('[app-api/cli-auth] could not load Clerk profile labels:', err);
    }

    const complete: CliAuthComplete = {
      status: 'complete',
      deviceCode: session.deviceCode,
      userCode: session.userCode,
      createdAt: session.createdAt,
      apiKey: key,
      keyId: id,
      keyPrefix: prefix,
      orgId,
      orgName,
      userId,
      email,
      apiUrl: defaultExternalApiUrl(c.env.ENVIRONMENT),
    };

    const remainingTtl = Math.max(
      30,
      CLI_AUTH_TTL_SECONDS - Math.floor((Date.now() - session.createdAt) / 1000),
    );
    await putCliAuthSession(c.env.WORKSPACE_CACHE, complete, remainingTtl);

    return success(c, {
      status: 'complete' as const,
      keyPrefix: prefix,
      orgId,
      orgName,
      email,
    });
  } catch (err) {
    console.error('[app-api/cli-auth] approve failed:', err);
    return error.internal(c, 'Failed to authorize the CLI');
  }
});

app.route('/approve', approve);

export const cliAuthRoutes = app;

/** Re-export for tests / docs. */
export { normalizeUserCode, formatUserCode };
