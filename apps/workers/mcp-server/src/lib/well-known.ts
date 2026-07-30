/**
 * OAuth discovery documents for the MCP server.
 *
 * MCP clients bootstrap authentication entirely from these:
 *   1. client calls /mcp with no token → 401 + `WWW-Authenticate: Bearer
 *      resource_metadata="…/.well-known/oauth-protected-resource"`
 *   2. client fetches that document → learns Clerk is the authorization server
 *   3. client fetches Clerk's authorization-server metadata → learns the
 *      registration/authorize/token endpoints
 *   4. client dynamically registers itself, runs the auth-code + PKCE flow,
 *      retries /mcp with a bearer token
 *
 * Step 3 requires Dynamic Client Registration to be enabled on the Clerk
 * instance, otherwise clients have nowhere to register.
 */

/** Path of the RFC 9728 protected-resource document. */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/** Path of the RFC 8414 authorization-server document. */
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';

/**
 * Scopes advertised to clients. `user:org:read` is not optional here — it is
 * what puts the `org_id` claim on the access token, and without an org the
 * server cannot pick a workspace (see `middleware/auth.ts`).
 */
export const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'user:org:read'];

/** CORS headers required on metadata endpoints (clients fetch them cross-origin). */
export const metadataCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-protocol-version',
};

/**
 * Derive the Clerk Frontend API origin from a publishable key.
 *
 * A publishable key is `pk_(test|live)_<base64>` where the payload decodes to
 * the FAPI host with a trailing `$` — e.g. `clerk.weldsuite.org$`. That host is
 * the OAuth issuer, so this avoids threading a second env var around.
 */
export function clerkFrontendApiUrl(publishableKey: string): string {
  const payload = publishableKey.replace(/^pk_(test|live)_/, '');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const host = atob(padded).replace(/\$$/, '');
  return `https://${host}`;
}

/** Absolute URL of this server's protected-resource document. */
export function protectedResourceMetadataUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/$/, '')}${PROTECTED_RESOURCE_PATH}`;
}

/**
 * RFC 9728 protected-resource metadata.
 *
 * `resource` must match the URL clients actually used to reach this server, or
 * they will reject the document as belonging to a different resource.
 */
export function protectedResourceMetadata(serverUrl: string, publishableKey: string) {
  return {
    resource: serverUrl.replace(/\/$/, ''),
    authorization_servers: [clerkFrontendApiUrl(publishableKey)],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

/**
 * Fetch Clerk's RFC 8414 authorization-server metadata.
 *
 * Mirrored from this origin because some MCP clients look for it on the
 * resource server rather than following `authorization_servers`.
 */
export async function fetchAuthorizationServerMetadata(
  publishableKey: string,
): Promise<Record<string, unknown>> {
  const issuer = clerkFrontendApiUrl(publishableKey);
  const res = await fetch(`${issuer}${AUTHORIZATION_SERVER_PATH}`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Clerk metadata request failed with status ${res.status}`);
  }

  return (await res.json()) as Record<string, unknown>;
}
