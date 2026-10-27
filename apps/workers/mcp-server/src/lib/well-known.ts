/**
 * OAuth discovery documents for the MCP server, built with Clerk's MCP tooling
 * (`@clerk/mcp-tools/server`).
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
import {
  corsHeaders,
  fetchClerkAuthorizationServerMetadata,
  generateClerkProtectedResourceMetadata,
} from '@clerk/mcp-tools/server';

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

/** Public guide for connecting an assistant, advertised as the resource's documentation. */
const SERVICE_DOCUMENTATION = 'https://help.weldsuite.org/settings/mcp-server';

/** CORS headers required on metadata endpoints (clients fetch them cross-origin). */
export const metadataCorsHeaders = corsHeaders;

/**
 * Derive the Clerk Frontend API origin from a publishable key.
 *
 * A publishable key is `pk_(test|live)_<base64>` where the payload decodes to
 * the FAPI host with a trailing `$` — e.g. `clerk.weldsuite.org$`. That host is
 * the OAuth issuer. Clerk's MCP tooling derives it the same way but does not
 * export the helper; the auth middleware needs it for `/oauth/userinfo`.
 */
export function clerkFrontendApiUrl(publishableKey: string): string {
  const payload = publishableKey.replace(/^pk_(test|live)_/, '');
  const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const host = atob(padded).replace(/\$$/, '');
  return `https://${host}`;
}

/** Absolute URL of this server's protected-resource document. */
export function protectedResourceMetadataUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/$/, '')}${PROTECTED_RESOURCE_PATH}`;
}

/**
 * RFC 9728 protected-resource metadata, from Clerk's generator.
 *
 * `resourcePath` is the path the client put after the well-known suffix: ''
 * for the bare document, '/mcp' for `…/oauth-protected-resource/mcp`. RFC 9728
 * §3.3 has a client discard a document whose `resource` differs from the URL
 * it looked the document up for, so each path answers with its own resource,
 * as Clerk's own handlers do. The origin is `MCP_SERVER_URL`, the same one the
 * 401's `WWW-Authenticate` header points at.
 */
export function protectedResourceMetadata(serverUrl: string, publishableKey: string, resourcePath = '') {
  return generateClerkProtectedResourceMetadata({
    publishableKey,
    resourceUrl: `${serverUrl.replace(/\/$/, '')}${resourcePath}`,
    properties: {
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      service_documentation: SERVICE_DOCUMENTATION,
    },
  });
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
  const metadata = (await fetchClerkAuthorizationServerMetadata({ publishableKey })) as Record<
    string,
    unknown
  > | null;

  // Clerk's helper returns whatever JSON came back, an error body included.
  // RFC 8414 makes `issuer` required, so without one this is not metadata.
  if (typeof metadata?.issuer !== 'string') {
    throw new Error('Clerk returned no authorization server metadata');
  }

  return metadata;
}
