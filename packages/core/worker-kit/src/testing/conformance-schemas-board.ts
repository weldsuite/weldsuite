/** WeldBoard (board-api) response schemas. Spread into ROUTES by conformance-schemas.ts. */
import {
  boardImportResultSchema,
  boardRenderSchema,
  boardRestoreResultSchema,
  boardSessionSchema,
  boardSnapshotResponseSchema,
  boardSummarySchema,
  boardTasksResultSchema,
  boardThumbnailSchema,
  boardVersionSchema,
  resolveBoardRecordsResultSchema,
  unfurlResultSchema,
} from '@weldsuite/app-api-client/schemas/boards';
import type { RouteSchema } from './conformance-schemas';

const B = '/api/boards';

export const BOARD_ROUTES: RouteSchema[] = [
  { method: 'GET', route: B, envelope: 'list', data: boardSummarySchema },
  { method: 'POST', route: B, envelope: 'single', data: boardSummarySchema },
  { method: 'POST', route: `${B}/import`, envelope: 'single', data: boardImportResultSchema },
  { method: 'POST', route: `${B}/convert`, envelope: 'single', data: boardSummarySchema },
  { method: 'POST', route: `${B}/unfurl`, envelope: 'single', data: unfurlResultSchema },
  { method: 'POST', route: `${B}/records`, envelope: 'single', data: resolveBoardRecordsResultSchema },
  { method: 'POST', route: `${B}/:id/tasks`, envelope: 'single', data: boardTasksResultSchema },
  { method: 'GET', route: `${B}/:id`, envelope: 'single', data: boardSummarySchema },
  { method: 'PATCH', route: `${B}/:id`, envelope: 'single', data: boardSummarySchema },
  { method: 'POST', route: `${B}/:id/session`, envelope: 'single', data: boardSessionSchema },
  { method: 'GET', route: `${B}/:id/snapshot`, envelope: 'single', data: boardSnapshotResponseSchema },
  { method: 'GET', route: `${B}/:id/thumbnail`, envelope: 'single', data: boardThumbnailSchema },
  { method: 'GET', route: `${B}/:id/render`, envelope: 'single', data: boardRenderSchema },
  { method: 'GET', route: `${B}/:id/versions`, envelope: 'list', data: boardVersionSchema },
  { method: 'POST', route: `${B}/:id/versions`, envelope: 'single', data: boardVersionSchema },
  { method: 'PATCH', route: `${B}/:id/versions/:versionId`, envelope: 'single', data: boardVersionSchema },
  { method: 'GET', route: `${B}/:id/versions/:versionId/snapshot`, envelope: 'single', data: boardSnapshotResponseSchema },
  { method: 'POST', route: `${B}/:id/versions/:versionId/restore`, envelope: 'single', data: boardRestoreResultSchema },
];
