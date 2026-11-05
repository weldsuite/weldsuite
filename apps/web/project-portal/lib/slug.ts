/**
 * A workspace slug as the portal's URL carries it (`projects.weldsuite.org/<workspace>`).
 * The pattern is flow-api's own (`PORTAL_SLUG_PATTERN` in commerce-domain's
 * portal-slug): lowercase letters, digits and hyphens. Anything else cannot be
 * a workspace, so it is a 404 here and never reaches a cookie name or the API.
 */
const SLUG_PATTERN = /^[a-z0-9-]{1,100}$/

export function parseWorkspaceSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase()
  return SLUG_PATTERN.test(slug) ? slug : null
}
