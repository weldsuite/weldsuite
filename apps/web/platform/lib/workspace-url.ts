/**
 * Workspace-in-URL helpers (FE-013 in weldsuite-documentation).
 *
 * A `/w/{ref}/…` link names the workspace it belongs to. `ref` is the
 * workspace slug in links people copy, or the Clerk org id in links the
 * backend builds (emails, OAuth returns), since the org id survives a slug
 * change. The `/w/$workspace` route resolves `ref` against the member's
 * workspaces, activates it in this tab, and continues to the inner path.
 */

export interface WorkspaceRef {
  /** Clerk organization id. */
  id: string;
  slug: string | null;
}

const WORKSPACE_PATH = /^\/w\/([^/]+)(\/.*)?$/;

/**
 * Split a raw (still percent-encoded) `/w/{ref}/…` pathname into the
 * decoded workspace ref and the encoded inner path. Returns null for any
 * other pathname.
 */
export function parseWorkspacePath(pathname: string): { ref: string; rest: string } | null {
  const match = WORKSPACE_PATH.exec(pathname);
  if (!match) return null;
  let ref: string;
  try {
    ref = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return { ref, rest: match[2] ?? '/' };
}

/**
 * Find the workspace a ref points at: the Clerk org id (exact) or the slug
 * (slugs are lowercase, so compare case-insensitively).
 */
export function findWorkspace<T extends WorkspaceRef>(ref: string, workspaces: readonly T[]): T | null {
  const slug = ref.toLowerCase();
  return workspaces.find((w) => w.id === ref || w.slug?.toLowerCase() === slug) ?? null;
}

/**
 * Resolve `path` against `origin` and return it as a same-origin path
 * (pathname + search + hash), or `/` when it would leave the origin.
 * Guards `/w/acme//evil.example` and its tab/backslash variants, which a
 * browser reads as protocol-relative URLs.
 */
export function sameOriginPath(path: string, origin: string): string {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

/**
 * Top-level segments of pages that are not inside a workspace: sign-in,
 * onboarding and invites (they pick or create one), the vendor W-9 form and
 * the mobile call room (a token in the link is the credential), the `/preview`
 * mirror, the `/welcome` redirect, and `/w` itself.
 */
const NON_WORKSPACE_SEGMENTS: ReadonlySet<string> = new Set([
  'auth',
  'onboarding',
  'invite',
  'w9',
  'w',
  'preview',
  'welcome',
  'call-room',
]);

/** Whether an in-app pathname belongs to a workspace, so a link to it names one. */
export function isWorkspaceScopedPath(pathname: string): boolean {
  const first = pathname.split('/', 2)[1] ?? '';
  return !NON_WORKSPACE_SEGMENTS.has(first);
}

/**
 * The in-app path of a browser pathname: `/w/acme/weldcrm` → `/weldcrm`.
 * For code that reads `window.location.pathname` instead of the router's
 * location; other pathnames are returned as they are.
 */
export function stripWorkspacePrefix(pathname: string): string {
  return parseWorkspacePath(pathname)?.rest ?? pathname;
}

/** `/w/{ref}{path}`: a link to `path` inside the given workspace. */
export function workspacePath(ref: string, path = '/'): string {
  const inner = path.startsWith('/') ? path : '/' + path;
  return `/w/${encodeURIComponent(ref)}${inner}`;
}
