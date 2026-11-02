/**
 * A stand-in for Clerk's Backend API, for route tests that call it through
 * `fetch`. It answers by method and URL from a scenario the test sets, never
 * by call order, so in conformance mode (where the Rust backend's calls reach
 * the same stub through the outbound bridge) both backends get the same
 * answers. Every call is recorded for assertions.
 */

import { vi } from 'vitest';

export interface ClerkMembershipFixture {
  id: string;
  role?: string;
  created_at?: number;
  public_metadata?: Record<string, unknown>;
  public_user_data: {
    user_id: string;
    identifier: string;
    first_name?: string | null;
    last_name?: string | null;
  };
}

export interface ClerkInvitationFixture {
  id: string;
  email_address?: string;
  status?: string;
  public_metadata?: Record<string, unknown>;
}

/** What one endpoint answers: a status and a JSON body. Status 0 makes `fetch` throw (Clerk unreachable). */
export interface ClerkAnswer {
  status: number;
  body?: unknown;
}

export interface ClerkScenario {
  /** `GET /organizations/:org`; null answers 404. */
  organization: { max_allowed_memberships?: number | null } | null;
  /** `GET …/memberships`: the full list (paged by `limit`/`offset`), or a failure. */
  memberships: ClerkMembershipFixture[] | ClerkAnswer;
  /** `GET …/invitations?status=pending`: the full list, or a failure. */
  invitations: ClerkInvitationFixture[] | ClerkAnswer;
  /** `GET /users?email_address=…`: user ids by email. */
  users: Record<string, string[]>;
  /** `POST …/memberships`. */
  addMembership: ClerkAnswer;
  /** `POST …/invitations`. */
  invite: ClerkAnswer;
  /** `POST …/invitations/:id/revoke`. */
  revoke: ClerkAnswer;
  /** `PATCH …/memberships/:user`. */
  setRole: ClerkAnswer;
  /** `DELETE …/memberships/:user`. */
  removeMembership: ClerkAnswer;
  /** `PATCH /organizations/:org`. */
  updateOrganization: ClerkAnswer;
}

export interface ClerkCall {
  method: string;
  url: string;
  body: unknown;
}

export function defaultClerkScenario(): ClerkScenario {
  return {
    organization: { max_allowed_memberships: null },
    memberships: [],
    invitations: [],
    users: {},
    addMembership: { status: 200, body: { id: 'orgmem_added' } },
    invite: { status: 200, body: { id: 'orginv_new' } },
    revoke: { status: 200, body: { id: 'orginv', status: 'revoked' } },
    setRole: { status: 200, body: {} },
    removeMembership: { status: 200, body: {} },
    updateOrganization: { status: 200, body: {} },
  };
}

function json(answer: ClerkAnswer): Response {
  if (answer.status === 0) throw new TypeError('fetch failed');
  return new Response(JSON.stringify(answer.body ?? {}), {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
}

function page<T>(list: T[] | ClerkAnswer, url: URL): Response {
  if (!Array.isArray(list)) return json(list);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 10);
  return json({ status: 200, body: { data: list.slice(offset, offset + limit), total_count: list.length } });
}

type Handler = (scenario: ClerkScenario, url: URL) => Response;

/** `<METHOD> <resource>/<id?>/<action?>` under `/organizations/:org`. */
const ORGANIZATION_ROUTES: Record<string, Handler> = {
  'GET ': (s) => (s.organization ? json({ status: 200, body: s.organization }) : json({ status: 404 })),
  'PATCH ': (s) => json(s.updateOrganization),
  'GET memberships': (s, url) => page(s.memberships, url),
  'POST memberships': (s) => json(s.addMembership),
  'PATCH memberships/:id': (s) => json(s.setRole),
  'DELETE memberships/:id': (s) => json(s.removeMembership),
  'GET invitations': (s, url) => page(s.invitations, url),
  'POST invitations': (s) => json(s.invite),
  'POST invitations/:id/revoke': (s) => json(s.revoke),
};

function route(scenario: ClerkScenario, method: string, url: URL): Response {
  const path = url.pathname.replace(/^\/v1/, '');
  if (path === '/users' && method === 'GET') {
    const email = url.searchParams.get('email_address') ?? '';
    return json({ status: 200, body: (scenario.users[email] ?? []).map((id) => ({ id })) });
  }
  const [root, , resource = '', id, action] = path.split('/').filter(Boolean);
  if (root !== 'organizations') return json({ status: 404 });
  const shape = [resource, id ? ':id' : '', action ?? ''].filter(Boolean).join('/');
  const handler = ORGANIZATION_ROUTES[`${method} ${shape}`];
  return handler ? handler(scenario, url) : json({ status: 404 });
}

function urlOf(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

/**
 * Stub `fetch` with the scenario. Returns the scenario (change it per test)
 * and the recorded calls.
 */
export function stubClerk(scenario: ClerkScenario = defaultClerkScenario()) {
  const calls: ClerkCall[] = [];
  // Anything that isn't Clerk (the conformance harness talking to the Rust
  // server) goes out as usual.
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.hostname !== 'api.clerk.com') return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = null;
      if (typeof init?.body === 'string' && init.body) body = JSON.parse(init.body) as unknown;
      calls.push({ method, url: url.href, body });
      return route(scenario, method, url);
    }),
  );
  return { scenario, calls };
}
