/**
 * OAuth 2.0 token endpoint for user-created apps (WeldApps).
 *
 * `grant_type=client_credentials` lets an app's own backend or agent exchange
 * its client credentials for a short-lived `wsat_` session token scoped to a
 * workspace that installed the app. Mounted OUTSIDE the authenticated /v1
 * group (like /health) — the credentials ARE the auth.
 *
 * Responses follow RFC 6749 (top-level `access_token` / `error`, NOT the
 * house `{data}` wrapper).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { HonoEnv } from '../types';
import { generateId } from '../lib/id';
import { createMasterDb, masterSchema } from '../lib/master-db';

const app = new Hono<HonoEnv>();

/** Session-token lifetime: 1 hour. */
const TOKEN_TTL_SECONDS = 3600;

type OAuthErrorCode = 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type';

function oauthError(
  c: Context<HonoEnv>,
  status: 400 | 401,
  code: OAuthErrorCode,
  description: string,
) {
  return c.json({ error: code, error_description: description }, status);
}

/** SHA-256 hex digest via Web Crypto (native to Workers). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish string comparison — no early exit on mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Mint a wsat_ token: 'wsat_' + 40 hex chars (20 random bytes). */
function generateAppToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `wsat_${hex}`;
}

interface TokenRequestBody {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  workspace_id?: string;
}

/** Accepts application/x-www-form-urlencoded (OAuth standard) or JSON. */
async function parseTokenRequest(c: Context<HonoEnv>): Promise<TokenRequestBody | null> {
  const contentType = c.req.header('Content-Type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await c.req.json()) as TokenRequestBody;
    }
    const form = await c.req.parseBody();
    const pick = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      grant_type: pick(form['grant_type']),
      client_id: pick(form['client_id']),
      client_secret: pick(form['client_secret']),
      workspace_id: pick(form['workspace_id']),
    };
  } catch {
    return null;
  }
}

app.post('/token', async (c) => {
  const body = await parseTokenRequest(c);
  if (!body) {
    return oauthError(c, 400, 'invalid_grant', 'Malformed request body');
  }

  if (body.grant_type !== 'client_credentials') {
    return oauthError(
      c,
      400,
      'unsupported_grant_type',
      'Only grant_type=client_credentials is supported',
    );
  }
  if (!body.client_id || !body.client_secret || !body.workspace_id) {
    return oauthError(
      c,
      400,
      'invalid_grant',
      'client_id, client_secret and workspace_id are required',
    );
  }

  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  // Client lookup + secret verification (constant-time-ish hash compare)
  const [client] = await masterDb
    .select({
      appId: masterSchema.userAppOauthClients.appId,
      clientSecretHash: masterSchema.userAppOauthClients.clientSecretHash,
    })
    .from(masterSchema.userAppOauthClients)
    .innerJoin(
      masterSchema.userApps,
      eq(masterSchema.userAppOauthClients.appId, masterSchema.userApps.id),
    )
    .where(
      and(
        eq(masterSchema.userAppOauthClients.clientId, body.client_id),
        eq(masterSchema.userApps.isActive, true),
        isNull(masterSchema.userApps.deletedAt),
      ),
    )
    .limit(1);

  const secretHash = await sha256Hex(body.client_secret);
  if (!client || !timingSafeEqual(secretHash, client.clientSecretHash)) {
    return oauthError(c, 401, 'invalid_client', 'Unknown client or invalid client secret');
  }

  // The app must have an ACTIVE install in the requested workspace
  const [install] = await masterDb
    .select({
      id: masterSchema.userAppInstalls.id,
      grantedScopes: masterSchema.userAppInstalls.grantedScopes,
    })
    .from(masterSchema.userAppInstalls)
    .where(
      and(
        eq(masterSchema.userAppInstalls.appId, client.appId),
        eq(masterSchema.userAppInstalls.workspaceId, body.workspace_id),
        eq(masterSchema.userAppInstalls.status, 'active'),
      ),
    )
    .limit(1);

  if (!install) {
    return oauthError(
      c,
      400,
      'invalid_grant',
      'App is not installed (or install is revoked) in the requested workspace',
    );
  }

  // Mint a short-lived session token scoped to the install's granted scopes
  const token = generateAppToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000);
  const scopes = (install.grantedScopes as string[]) ?? [];

  await masterDb.insert(masterSchema.userAppTokens).values({
    id: generateId('uat'),
    installId: install.id,
    appId: client.appId,
    workspaceId: body.workspace_id,
    tokenHash,
    tokenPrefix: token.slice(0, 12),
    tokenType: 'session',
    scopes,
    expiresAt,
    createdAt: now,
  });

  return c.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
    scope: scopes.join(' '),
  });
});

export default app;
