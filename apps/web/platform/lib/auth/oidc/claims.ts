/**
 * From OIDC claims to the facade's person and workspaces (ADR SEC-012).
 *
 * A workspace is an organization in the identity provider. The backend reads
 * the session's workspace from one claim, `orgClaim` in `/config.json`
 * (`OIDC_ORG_CLAIM` on the Rust backend), and the platform reads the same
 * claim the same way (`organization()` in `rust/crates/auth/src/oidc.rs`):
 *
 * - a string: the organization id;
 * - an array: its one distinct id;
 * - an object shaped like Zitadel's project roles claim
 *   (`{ "<role>": { "<orgId>": "<org domain>" } }`): the one organization it
 *   grants roles in.
 *
 * More than one organization is none: the token isn't for a workspace yet.
 *
 * The EU edition (Zitadel) uses the project roles claim
 * `urn:zitadel:iam:org:project:<projectId>:roles`. Zitadel's
 * `urn:zitadel:iam:org:id` only names the person's own organization, so it
 * can't serve someone in several workspaces. A token requested without an
 * organization scope lists every organization that granted the person a role
 * on the project, which is their workspace list; one requested with
 * `urn:zitadel:iam:org:roles:id:<orgId>` is narrowed to that organization,
 * which makes it the active workspace (`session.ts`).
 */

/** The Rust backend's default `OIDC_ORG_CLAIM`. */
export const DEFAULT_ORG_CLAIM = 'urn:zitadel:iam:org:id';
/** Scope that makes Zitadel assert project roles. */
export const ZITADEL_ROLES_SCOPE = 'urn:zitadel:iam:org:projects:roles';
/** Narrows the roles claims to one organization: the token's workspace. */
export const ZITADEL_ORG_ROLES_SCOPE = 'urn:zitadel:iam:org:roles:id:{orgId}';
/** Adds the project to `aud`, which the backend checks (`OIDC_AUDIENCE`). */
export const ZITADEL_AUDIENCE_SCOPE = 'urn:zitadel:iam:org:project:id:{audience}:aud';

const ZITADEL_ROLES = /^urn:zitadel:iam:org:project:(?:[^:]+:)?roles$/;
const ZITADEL_RESOURCE_OWNER_ID = 'urn:zitadel:iam:user:resourceowner:id';
const ZITADEL_RESOURCE_OWNER_NAME = 'urn:zitadel:iam:user:resourceowner:name';

export type Claims = Record<string, unknown>;

export interface OidcOrganization {
  id: string;
  name: string;
  /** Providers don't have WeldSuite's workspace slug; the URL falls back to the id. */
  slug: null;
}

export interface OidcPerson {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  username: string | null;
  imageUrl: string;
  email: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `[orgId, name]` pairs from one claim value, whichever of the supported shapes it has. */
function entries(value: unknown): Array<[string, string]> {
  const single = str(value);
  if (single) return [[single, single]];
  if (Array.isArray(value)) {
    return value.map(str).filter((id): id is string => id !== null).map((id) => [id, id]);
  }
  if (!isRecord(value)) return [];
  // Zitadel roles: { role: { orgId: domain } }
  return Object.values(value)
    .filter(isRecord)
    .flatMap((orgs) => Object.entries(orgs))
    .filter(([orgId]) => orgId !== '')
    .map(([orgId, domain]): [string, string] => [orgId, str(domain) ?? orgId]);
}

/** Add a claim value's organizations to `into`, first name wins. */
function collect(value: unknown, into: Map<string, string>): void {
  for (const [id, name] of entries(value)) {
    if (!into.has(id)) into.set(id, name);
  }
}

/** The session's organization from the org claim, exactly as the backend reads it. Null = none. */
export function activeOrganizationId(claims: Claims, orgClaim: string): string | null {
  const found = new Map<string, string>();
  collect(claims[orgClaim], found);
  return found.size === 1 ? [...found.keys()][0] : null;
}

/**
 * Every organization the token mentions: the org claim plus Zitadel's
 * project roles claims. From a token requested without an organization scope
 * that is the person's workspace list.
 */
export function organizationsFromClaims(claims: Claims, orgClaim: string): OidcOrganization[] {
  const found = new Map<string, string>();
  collect(claims[orgClaim], found);
  for (const [key, value] of Object.entries(claims)) {
    if (key !== orgClaim && ZITADEL_ROLES.test(key)) collect(value, found);
  }
  // The user's own organization has a display name; the roles claim only has its domain.
  const ownerId = str(claims[ZITADEL_RESOURCE_OWNER_ID]);
  const ownerName = str(claims[ZITADEL_RESOURCE_OWNER_NAME]);
  if (ownerId && ownerName && found.has(ownerId)) found.set(ownerId, ownerName);
  return [...found].map(([id, name]) => ({ id, name, slug: null }));
}

/** Fill `{orgId}` / `{audience}` in a scope template. */
export function scopeFor(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** Standard OIDC profile claims → the facade's person. */
export function personFromClaims(claims: Claims): OidcPerson | null {
  const id = str(claims.sub);
  if (!id) return null;
  const firstName = str(claims.given_name);
  const lastName = str(claims.family_name);
  const joined = [firstName, lastName].filter(Boolean).join(' ');
  return {
    id,
    firstName,
    lastName,
    fullName: str(claims.name) ?? (joined || null),
    username: str(claims.preferred_username),
    imageUrl: str(claims.picture) ?? '',
    email: str(claims.email),
  };
}
