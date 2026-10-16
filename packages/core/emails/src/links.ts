/**
 * A link from an email into the platform, inside one workspace:
 * `{baseUrl}/w/{clerkOrgId}{path}` (FE-013 in weldsuite-documentation).
 *
 * The platform resolves the org id, switches the reader's tab to that
 * workspace and opens `path`, so a member of several workspaces lands in the
 * right one. The org id is used rather than the slug because it survives a
 * slug change. Without an org id this is the bare `{baseUrl}{path}`, which
 * opens in whichever workspace the reader has active.
 */
export function workspaceAppUrl(baseUrl: string, clerkOrgId: string | null | undefined, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const inner = path.startsWith('/') ? path : `/${path}`;
  return clerkOrgId ? `${base}/w/${encodeURIComponent(clerkOrgId)}${inner}` : `${base}${inner}`;
}
