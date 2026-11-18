/** WeldPanel (panel-api) response schemas: projects, the install check, queries and the lexicon. Spread into ROUTES by conformance-schemas.ts. */
import { z } from 'zod';
import { panelInstallInfoSchema, panelProjectDtoSchema } from '@weldsuite/app-api-client/schemas/weldpanel';
import { PANEL_QUERY_KINDS } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { RouteSchema } from './conformance-schemas';

/** `PanelQueryResponse`: the kind's result, when the data was read and whether it came from the cache. */
const panelQueryResponseSchema = z
  .object({
    kind: z.enum(PANEL_QUERY_KINDS),
    result: z.record(z.string(), z.unknown()),
    dataAsOf: z.string().datetime(),
    cached: z.boolean(),
  })
  .strict();

/** `PanelLexiconEntry`. */
const panelLexiconEntrySchema = z
  .object({
    name: z.string(),
    seen: z.boolean(),
    count30d: z.number().nullable(),
    description: z.string().nullable(),
    hidden: z.boolean(),
    verified: z.boolean(),
    definitionId: z.string().nullable(),
  })
  .strict();

/** `PanelLexiconDto`. */
const panelLexiconSchema = z
  .object({
    events: z.array(panelLexiconEntrySchema),
    properties: z.array(panelLexiconEntrySchema),
    scannedAt: z.string().datetime(),
  })
  .strict();

export const PANEL_ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/panel/projects', envelope: 'list', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id/settings', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects/:id/rotate-token', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id/install', envelope: 'single', data: panelInstallInfoSchema },
  { method: 'POST', route: '/api/panel/query', envelope: 'single', data: panelQueryResponseSchema },
  { method: 'GET', route: '/api/panel/lexicon', envelope: 'single', data: panelLexiconSchema },
  { method: 'PATCH', route: '/api/panel/lexicon', envelope: 'single', data: panelLexiconEntrySchema },
];
