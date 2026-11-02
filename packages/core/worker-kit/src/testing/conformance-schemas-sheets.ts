/** WeldSheets (sheets-api) response schemas. Spread into ROUTES by conformance-schemas.ts. */
import {
  sheetDataRefreshResultSchema,
  sheetDataSourceSchema,
  sheetImportResultSchema,
  sheetRestoreResultSchema,
  sheetSessionSchema,
  sheetSummarySchema,
  sheetVersionSchema,
  sheetVersionSnapshotSchema,
} from '@weldsuite/app-api-client/schemas/sheets';
import type { RouteSchema } from './conformance-schemas';

const S = '/api/sheets';

export const SHEETS_ROUTES: RouteSchema[] = [
  { method: 'GET', route: S, envelope: 'list', data: sheetSummarySchema },
  { method: 'POST', route: S, envelope: 'single', data: sheetSummarySchema },
  { method: 'POST', route: `${S}/import`, envelope: 'single', data: sheetImportResultSchema },
  { method: 'POST', route: `${S}/convert`, envelope: 'single', data: sheetSummarySchema },
  { method: 'GET', route: `${S}/:id`, envelope: 'single', data: sheetSummarySchema },
  { method: 'PATCH', route: `${S}/:id`, envelope: 'single', data: sheetSummarySchema },
  { method: 'POST', route: `${S}/:id/session`, envelope: 'single', data: sheetSessionSchema },
  { method: 'GET', route: `${S}/:id/versions`, envelope: 'list', data: sheetVersionSchema },
  { method: 'POST', route: `${S}/:id/versions`, envelope: 'single', data: sheetVersionSchema },
  { method: 'PATCH', route: `${S}/:id/versions/:versionId`, envelope: 'single', data: sheetVersionSchema },
  { method: 'GET', route: `${S}/:id/versions/:versionId/snapshot`, envelope: 'single', data: sheetVersionSnapshotSchema },
  { method: 'POST', route: `${S}/:id/versions/:versionId/restore`, envelope: 'single', data: sheetRestoreResultSchema },
  { method: 'GET', route: `${S}/:id/data-sources`, envelope: 'list', data: sheetDataSourceSchema },
  { method: 'POST', route: `${S}/:id/data-sources`, envelope: 'single', data: sheetDataRefreshResultSchema },
  { method: 'PATCH', route: `${S}/:id/data-sources/:sourceId`, envelope: 'single', data: sheetDataRefreshResultSchema },
  { method: 'POST', route: `${S}/:id/data-sources/:sourceId/refresh`, envelope: 'single', data: sheetDataRefreshResultSchema },
];
