/**
 * The person's workspaces as WeldSuite knows them (`GET /api/workspaces`):
 * what an OIDC token can't say.
 *
 * The token names a workspace by its provider organization id, and Zitadel's
 * roles claim gives only the organization's generated domain
 * (`acme.auth.weldsuite.eu`) for its name. The workspace's own name and slug
 * live in WeldSuite's master database, so the session reads them from the
 * API and shows them in the switcher and in `/w/{slug}` links, as Clerk's
 * organizations do on Global. The list also has workspaces created after the
 * token was issued, which the token can't name yet.
 */

import { getAppApiUrl } from '@/lib/api/public-env';
import { parseWorkspaceDirectory } from '@weldsuite/app-api-client/auth/oidc-claims';

/** `{ data: [{ id, name, slug, … }] }` → entries; anything else → null. Shared with the mobile apps. */
export { parseWorkspaceDirectory };

export interface WorkspaceDirectoryEntry {
  /**
   * The provider organization id (`workspaces.clerk_org_id`); in `header`
   * mode (WeldID) `workspaces.id`.
   */
  id: string;
  name: string;
  slug: string | null;
}

/** Reads the directory with the session's token; null when it can't be read. */
export type LoadWorkspaces = (token: string) => Promise<WorkspaceDirectoryEntry[] | null>;

/** `GET {api}/api/workspaces`, as the platform's API client would call it. */
export const loadWorkspacesFromApi: LoadWorkspaces = async (token) => {
  try {
    const response = await fetch(`${getAppApiUrl()}/api/workspaces`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return parseWorkspaceDirectory(await response.json());
  } catch {
    return null;
  }
};
