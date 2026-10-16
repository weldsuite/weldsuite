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

/** `/w/{ref}{path}`: a link to `path` inside the given workspace. */
export function workspacePath(ref: string, path = '/'): string {
  return `/w/${encodeURIComponent(ref)}${path.startsWith('/') ? path : `/${path}`}`;
}
