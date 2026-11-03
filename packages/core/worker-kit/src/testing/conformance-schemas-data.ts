/** WeldData (data-api) response schemas. Spread into ROUTES by conformance-schemas.ts. */
import {
  enrichFieldDefinitionSchema,
  enrichFieldDeletedSchema,
  enrichFieldResultSchema,
  enrichFieldsReorderedSchema,
  enrichmentLogSchema,
  lemlistFilterCatalogSchema,
  lemlistSearchResultSchema,
  welddataAddLeadsResultSchema,
  welddataCellSchema,
  welddataColumnSchema,
  welddataConvertLeadResultSchema,
  welddataConvertSearchLeadsResultSchema,
  welddataConvertToCrmListResultSchema,
  welddataLeadSchema,
  welddataListSchema,
  welddataListWithCountSchema,
  welddataQueuedSchema,
} from '@weldsuite/app-api-client/schemas/welddata-responses';
import type { RouteSchema } from './conformance-schemas';

const W = '/api/welddata';

export const DATA_ROUTES: RouteSchema[] = [
  // the lead database
  { method: 'GET', route: `${W}/filters`, envelope: 'single', data: lemlistFilterCatalogSchema },
  { method: 'POST', route: `${W}/search/people`, envelope: 'single', data: lemlistSearchResultSchema },
  { method: 'POST', route: `${W}/search/companies`, envelope: 'single', data: lemlistSearchResultSchema },
  // lists and saved leads
  { method: 'GET', route: `${W}/lists`, envelope: 'list', data: welddataListWithCountSchema },
  { method: 'POST', route: `${W}/lists`, envelope: 'single', data: welddataListSchema },
  { method: 'GET', route: `${W}/lists/:id`, envelope: 'single', data: welddataListWithCountSchema },
  { method: 'PATCH', route: `${W}/lists/:id`, envelope: 'single', data: welddataListSchema },
  { method: 'GET', route: `${W}/lists/:id/leads`, envelope: 'list', data: welddataLeadSchema },
  { method: 'POST', route: `${W}/lists/:id/leads`, envelope: 'single', data: welddataAddLeadsResultSchema },
  // conversion into CRM
  { method: 'POST', route: `${W}/leads/:id/convert`, envelope: 'single', data: welddataConvertLeadResultSchema },
  { method: 'POST', route: `${W}/convert`, envelope: 'single', data: welddataConvertSearchLeadsResultSchema },
  { method: 'POST', route: `${W}/convert-to-list`, envelope: 'single', data: welddataConvertToCrmListResultSchema },
  // enrichment columns, cells and runs
  { method: 'GET', route: `${W}/lists/:id/columns`, envelope: 'array', data: welddataColumnSchema },
  { method: 'POST', route: `${W}/lists/:id/columns`, envelope: 'single', data: welddataColumnSchema },
  { method: 'PATCH', route: `${W}/columns/:id`, envelope: 'single', data: welddataColumnSchema },
  { method: 'GET', route: `${W}/lists/:id/cells`, envelope: 'array', data: welddataCellSchema },
  { method: 'POST', route: `${W}/lists/:id/columns/:columnId/run`, envelope: 'single', data: welddataQueuedSchema },
  { method: 'POST', route: `${W}/cells/run`, envelope: 'single', data: welddataQueuedSchema },
  // enrich field definitions
  { method: 'GET', route: '/api/enrich-fields', envelope: 'array', data: enrichFieldDefinitionSchema },
  { method: 'POST', route: '/api/enrich-fields', envelope: 'single', data: enrichFieldDefinitionSchema },
  { method: 'PUT', route: '/api/enrich-fields/reorder', envelope: 'single', data: enrichFieldsReorderedSchema },
  { method: 'PUT', route: '/api/enrich-fields/:id', envelope: 'single', data: enrichFieldDefinitionSchema },
  { method: 'DELETE', route: '/api/enrich-fields/:id', envelope: 'single', data: enrichFieldDeletedSchema },
  // the enrichment views
  { method: 'GET', route: '/api/enrichments', envelope: 'array', data: enrichFieldResultSchema },
  { method: 'GET', route: '/api/enrichments/definitions', envelope: 'array', data: enrichFieldDefinitionSchema },
  { method: 'GET', route: '/api/enrichments/logs', envelope: 'list', data: enrichmentLogSchema },
];
