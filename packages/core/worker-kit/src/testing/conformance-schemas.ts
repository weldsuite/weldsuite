/**
 * The Zod response schema of each route the Rust backend serves, for
 * conformance mode (./conformance.ts): every successful Rust response is
 * validated against it, so a shape the clients can't parse fails even where a
 * test's assertions don't look.
 *
 * Keyed by method and the Hono route pattern (`/api/companies/:id`). Register
 * a route here when its module is ported (playbook step 5). Schemas come from
 * the client packages, which is what the platform and the mobile apps parse
 * responses with.
 */

import { accessRequestSchema } from '@weldsuite/app-api-client/schemas/access-requests';
import { featureFlagsResponseSchema } from '@weldsuite/app-api-client/schemas/feature-flags';
import { myPermissionsSchema } from '@weldsuite/app-api-client/schemas/me';
import {
  knowledgeFavoriteRefSchema,
  knowledgeFavoriteSchema,
  knowledgeMembershipSchema,
  knowledgePageSchema,
  knowledgePageTreeNodeSchema,
  knowledgePageVersionSchema,
  knowledgePageVersionSummarySchema,
  knowledgeSavedContentSchema,
  knowledgeSpaceMemberSchema,
  knowledgeSpaceRowSchema,
  knowledgeSpaceSchema,
  knowledgeTeammateSchema,
  knowledgeTrashedPageSchema,
} from '@weldsuite/core-api-client/schemas/knowledge';
import {
  deletedResultSchema,
  driveFileSchema,
  moveFileResultSchema,
  pinFileResultSchema,
  starFileResultSchema,
  unifiedFileSchema,
} from '@weldsuite/core-api-client/schemas/files';
import { driveFolderSchema } from '@weldsuite/core-api-client/schemas/folders';
import { driveItemSharingSchema } from '@weldsuite/core-api-client/schemas/drive-shares';
import {
  driveStatsSchema,
  driveTrashSchema,
  emptiedResultSchema,
  restoredResultSchema,
  sharedWithMeSchema,
} from '@weldsuite/core-api-client/schemas/drive';
import { searchResultGroupSchema } from '@weldsuite/app-api-client/schemas/search';

/** The parts of a Zod schema this file needs, so worker-kit doesn't depend on zod. */
interface ResponseSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { message: string } };
}

type Envelope = 'single' | 'list';

interface RouteSchema {
  method: string;
  route: string;
  /** `{ data: T }` or `{ data: T[], pagination }`. */
  envelope: Envelope;
  data: ResponseSchema;
}

const ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/me/permissions', envelope: 'single', data: myPermissionsSchema },
  { method: 'GET', route: '/api/feature-flags', envelope: 'single', data: featureFlagsResponseSchema },
  { method: 'POST', route: '/api/access-requests', envelope: 'single', data: accessRequestSchema },
  { method: 'PATCH', route: '/api/access-requests/:id', envelope: 'single', data: accessRequestSchema },
  { method: 'GET', route: '/api/access-requests/me/pending', envelope: 'list', data: accessRequestSchema },
  // know (WeldKnow)
  { method: 'GET', route: '/api/knowledge/spaces', envelope: 'list', data: knowledgeSpaceSchema },
  { method: 'POST', route: '/api/knowledge/spaces', envelope: 'single', data: knowledgeSpaceRowSchema },
  { method: 'PATCH', route: '/api/knowledge/spaces/:id', envelope: 'single', data: knowledgeSpaceRowSchema },
  { method: 'GET', route: '/api/knowledge/teammates', envelope: 'list', data: knowledgeTeammateSchema },
  { method: 'GET', route: '/api/knowledge/spaces/:id/members', envelope: 'list', data: knowledgeSpaceMemberSchema },
  { method: 'POST', route: '/api/knowledge/spaces/:id/members', envelope: 'single', data: knowledgeMembershipSchema },
  { method: 'PATCH', route: '/api/knowledge/spaces/:id/members/:userId', envelope: 'single', data: knowledgeMembershipSchema },
  { method: 'POST', route: '/api/knowledge/spaces/:id/join', envelope: 'single', data: knowledgeMembershipSchema },
  { method: 'GET', route: '/api/knowledge/pages/tree', envelope: 'list', data: knowledgePageTreeNodeSchema },
  { method: 'GET', route: '/api/knowledge/trash', envelope: 'list', data: knowledgeTrashedPageSchema },
  { method: 'GET', route: '/api/knowledge/pages/:id', envelope: 'single', data: knowledgePageSchema },
  { method: 'POST', route: '/api/knowledge/pages', envelope: 'single', data: knowledgePageSchema },
  { method: 'PATCH', route: '/api/knowledge/pages/:id', envelope: 'single', data: knowledgePageSchema },
  { method: 'PUT', route: '/api/knowledge/pages/:id/content', envelope: 'single', data: knowledgeSavedContentSchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/move', envelope: 'single', data: knowledgePageSchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/restore', envelope: 'single', data: knowledgePageSchema },
  { method: 'GET', route: '/api/knowledge/pages/:id/versions', envelope: 'list', data: knowledgePageVersionSummarySchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/versions', envelope: 'single', data: knowledgePageVersionSchema },
  { method: 'GET', route: '/api/knowledge/pages/:id/versions/:versionId', envelope: 'single', data: knowledgePageVersionSchema },
  { method: 'POST', route: '/api/knowledge/pages/:id/versions/:versionId/restore', envelope: 'single', data: knowledgePageSchema },
  { method: 'GET', route: '/api/knowledge/favorites', envelope: 'list', data: knowledgeFavoriteSchema },
  { method: 'POST', route: '/api/knowledge/favorites', envelope: 'single', data: knowledgeFavoriteRefSchema },
  // core: files (the lists page in memory: `{ success, data, pagination: { page, … } }`)
  { method: 'GET', route: '/api/files', envelope: 'single', data: unifiedFileSchema.array() },
  { method: 'GET', route: '/api/files/:id', envelope: 'single', data: driveFileSchema },
  { method: 'POST', route: '/api/files', envelope: 'single', data: driveFileSchema },
  { method: 'PATCH', route: '/api/files/:id', envelope: 'single', data: driveFileSchema },
  { method: 'DELETE', route: '/api/files/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'POST', route: '/api/files/:id/star', envelope: 'single', data: starFileResultSchema },
  { method: 'POST', route: '/api/files/:id/pin', envelope: 'single', data: pinFileResultSchema },
  { method: 'PUT', route: '/api/files/:id/content', envelope: 'single', data: driveFileSchema },
  { method: 'POST', route: '/api/files/:id/move', envelope: 'single', data: moveFileResultSchema },
  { method: 'GET', route: '/api/files/:id/shares', envelope: 'single', data: driveItemSharingSchema },
  { method: 'PUT', route: '/api/files/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema },
  { method: 'DELETE', route: '/api/files/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema.nullable() },
  // core: folders
  { method: 'GET', route: '/api/folders', envelope: 'single', data: driveFolderSchema.array() },
  { method: 'GET', route: '/api/folders/:id', envelope: 'single', data: driveFolderSchema },
  { method: 'POST', route: '/api/folders', envelope: 'single', data: driveFolderSchema },
  { method: 'PATCH', route: '/api/folders/:id', envelope: 'single', data: driveFolderSchema },
  { method: 'DELETE', route: '/api/folders/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'GET', route: '/api/folders/:id/shares', envelope: 'single', data: driveItemSharingSchema },
  { method: 'PUT', route: '/api/folders/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema },
  { method: 'DELETE', route: '/api/folders/:id/shares/:userId', envelope: 'single', data: driveItemSharingSchema.nullable() },
  // core: drive
  { method: 'GET', route: '/api/drive/all', envelope: 'single', data: unifiedFileSchema.array() },
  { method: 'GET', route: '/api/drive/stats', envelope: 'single', data: driveStatsSchema },
  { method: 'GET', route: '/api/drive/shared', envelope: 'single', data: sharedWithMeSchema },
  { method: 'GET', route: '/api/drive/trash', envelope: 'single', data: driveTrashSchema },
  { method: 'POST', route: '/api/drive/trash/restore/file/:id', envelope: 'single', data: restoredResultSchema },
  { method: 'POST', route: '/api/drive/trash/restore/folder/:id', envelope: 'single', data: restoredResultSchema },
  { method: 'DELETE', route: '/api/drive/trash/file/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'DELETE', route: '/api/drive/trash/folder/:id', envelope: 'single', data: deletedResultSchema },
  { method: 'DELETE', route: '/api/drive/trash/empty', envelope: 'single', data: emptiedResultSchema },
  // core: search (`{ data: groups, query, permittedTypes, understanding }`)
  { method: 'POST', route: '/api/search', envelope: 'single', data: searchResultGroupSchema.array() },
];

/** null when valid, else why not. */
type Validator = (body: unknown) => string | null;

function validate(entry: RouteSchema, body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('data' in body)) return 'no `data` in the response envelope';
  const data = (body as { data: unknown }).data;
  if (entry.envelope === 'list') {
    if (!Array.isArray(data)) return '`data` is not an array';
    const pagination = (body as { pagination?: unknown }).pagination as Record<string, unknown> | undefined;
    if (
      !pagination ||
      typeof pagination.totalCount !== 'number' ||
      typeof pagination.hasMore !== 'boolean' ||
      !(typeof pagination.cursor === 'string' || pagination.cursor === null)
    ) {
      return '`pagination` is not { totalCount, hasMore, cursor }';
    }
    for (const [i, item] of data.entries()) {
      const result = entry.data.safeParse(item);
      if (!result.success) return `data[${i}]: ${result.error.message}`;
    }
    return null;
  }
  const result = entry.data.safeParse(data);
  return result.success ? null : result.error.message;
}

/** The validator registered for a route, if any. */
export function schemaFor(method: string, route: string): Validator | undefined {
  const entry = ROUTES.find((r) => r.method === method && r.route === route);
  return entry ? (body) => validate(entry, body) : undefined;
}

/** Every registered route, for the coverage report. */
export function registeredRoutes(): ReadonlyArray<{ method: string; route: string }> {
  return ROUTES.map(({ method, route }) => ({ method, route }));
}
