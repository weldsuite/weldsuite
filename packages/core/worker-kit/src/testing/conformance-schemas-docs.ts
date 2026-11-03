/** WeldDocs (docs-api) response schemas. Spread into ROUTES by conformance-schemas.ts. */
import {
  docRestoreResultSchema,
  docSessionSchema,
  docSnapshotResponseSchema,
  docSummarySchema,
  docVersionSchema,
} from '@weldsuite/app-api-client/schemas/docs';
import type { RouteSchema } from './conformance-schemas';

const D = '/api/docs';

export const DOCS_ROUTES: RouteSchema[] = [
  { method: 'GET', route: D, envelope: 'list', data: docSummarySchema },
  { method: 'POST', route: D, envelope: 'single', data: docSummarySchema },
  { method: 'GET', route: `${D}/:id`, envelope: 'single', data: docSummarySchema },
  { method: 'PATCH', route: `${D}/:id`, envelope: 'single', data: docSummarySchema },
  { method: 'POST', route: `${D}/:id/session`, envelope: 'single', data: docSessionSchema },
  { method: 'GET', route: `${D}/:id/snapshot`, envelope: 'single', data: docSnapshotResponseSchema },
  { method: 'GET', route: `${D}/:id/versions`, envelope: 'list', data: docVersionSchema },
  { method: 'POST', route: `${D}/:id/versions`, envelope: 'single', data: docVersionSchema },
  { method: 'PATCH', route: `${D}/:id/versions/:versionId`, envelope: 'single', data: docVersionSchema },
  { method: 'GET', route: `${D}/:id/versions/:versionId/snapshot`, envelope: 'single', data: docSnapshotResponseSchema },
  { method: 'POST', route: `${D}/:id/versions/:versionId/restore`, envelope: 'single', data: docRestoreResultSchema },
];
