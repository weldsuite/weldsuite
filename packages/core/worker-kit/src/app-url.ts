/**
 * A link a worker sends the browser to (Stripe or OAuth return, redirect),
 * inside one workspace: `{baseUrl}/w/{clerkOrgId}{path}` (FE-013 in
 * weldsuite-documentation).
 *
 * A full-page round trip through Stripe or an OAuth provider reloads the
 * platform in the session's last active workspace, which need not be the one
 * that started the flow; the `/w/{orgId}` prefix brings the tab back to it.
 * Without an org id this is the bare `{baseUrl}{path}`.
 *
 * Mirrors `workspaceAppUrl` in packages/core/emails/src/links.ts (emails does
 * not depend on worker-kit); keep the two in sync.
 */
export function workspaceAppUrl(baseUrl: string, clerkOrgId: string | null | undefined, path: string): string {
  let base = baseUrl.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  const inner = path.startsWith('/') ? path : `/${path}`;
  return clerkOrgId ? `${base}/w/${encodeURIComponent(clerkOrgId)}${inner}` : `${base}${inner}`;
}
