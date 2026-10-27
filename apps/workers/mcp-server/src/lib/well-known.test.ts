/**
 * The OAuth discovery documents, built with Clerk's MCP tooling. They are what
 * an MCP client reads before it has a token, so their shape is the contract:
 * Clerk as the authorization server, `user:org:read` advertised (no org, no
 * workspace), and a `resource` that matches the URL the document was looked up
 * for (RFC 9728 §3.3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthorizationServerMetadata, protectedResourceMetadata } from './well-known';

/** The public test publishable key; it decodes to `definite-eagle-3.clerk.accounts.dev`. */
const PUBLISHABLE_KEY = 'pk_test_ZGVmaW5pdGUtZWFnbGUtMy5jbGVyay5hY2NvdW50cy5kZXYk';
const ISSUER = 'https://definite-eagle-3.clerk.accounts.dev';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('protectedResourceMetadata', () => {
  it('names Clerk as the authorization server and advertises the org scope', () => {
    const metadata = protectedResourceMetadata('https://mcp.weldsuite.org', PUBLISHABLE_KEY);

    expect(metadata).toMatchObject({
      resource: 'https://mcp.weldsuite.org',
      authorization_servers: [ISSUER],
      scopes_supported: ['openid', 'profile', 'email', 'user:org:read'],
      bearer_methods_supported: ['header'],
      service_documentation: 'https://help.weldsuite.org/settings/mcp-server',
    });
  });

  it('answers the /mcp lookup for the /mcp resource', () => {
    expect(protectedResourceMetadata('https://mcp.weldsuite.org/', PUBLISHABLE_KEY, '/mcp').resource).toBe(
      'https://mcp.weldsuite.org/mcp',
    );
  });

  it('throws on a publishable key that does not decode, for the route to answer 502', () => {
    expect(() => protectedResourceMetadata('https://mcp.weldsuite.org', 'pk_test_%%%')).toThrow();
  });
});

describe('fetchAuthorizationServerMetadata', () => {
  it("returns Clerk's document from the instance's frontend API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ issuer: ISSUER, registration_endpoint: `${ISSUER}/oauth/register` }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAuthorizationServerMetadata(PUBLISHABLE_KEY)).resolves.toMatchObject({ issuer: ISSUER });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
  });

  it('refuses an answer that is not metadata, such as an error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ errors: [{ code: 'not_found' }] }, { status: 404 })));

    await expect(fetchAuthorizationServerMetadata(PUBLISHABLE_KEY)).rejects.toThrow(
      'Clerk returned no authorization server metadata',
    );
  });
});
