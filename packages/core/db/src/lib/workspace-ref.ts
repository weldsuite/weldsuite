/**
 * Looking a workspace up by either of its two identifiers.
 *
 * A workspace has our id, `workspaces.id` (`ws_…`), and Clerk's,
 * `workspaces.clerk_org_id` (`org_…`). The platform is moving to `workspaces.id`
 * everywhere (docs/plans/workspace-id-standardization.md), but until every
 * stored row, queued message and sleeping Workflow carries it, a reader must
 * accept either: a value written yesterday holds the org id, one written after
 * the switch holds the workspace id.
 *
 * Match both columns instead of guessing from the prefix. Early workspaces
 * were created with `id` set to their Clerk org id (`provisionWorkspace` in
 * ./tenant.ts used to do that), so an `org_…` value can be either column. One
 * value cannot reach two rows: `id` is the primary key, `clerk_org_id` is
 * unique, and the early rows hold the same value in both.
 */

import { eq, or, type SQL } from 'drizzle-orm';
import { workspaces } from '../schema/master';

/** `workspaces.id = ref OR workspaces.clerk_org_id = ref`. */
export function matchWorkspaceRef(ref: string): SQL {
  return or(eq(workspaces.id, ref), eq(workspaces.clerkOrgId, ref)) as SQL;
}
