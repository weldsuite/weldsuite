/**
 * WeldPanel response schemas: panel-api's projects and the install check, and
 * the collector's (panel-ingest) JSON answers. Spread into ROUTES by
 * conformance-schemas.ts.
 */
import { z } from 'zod';
import { panelInstallInfoSchema, panelProjectDtoSchema } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { RouteSchema } from './conformance-schemas';

/** `ClientConfig` of `@weldsuite/panel-domain/wire`: what `GET /c/:token` answers. */
const panelClientConfigSchema = z
  .object({
    autocapture: z.boolean(),
    consentMode: z.enum(['required', 'none']),
    maskingLevel: z.enum(['strict', 'balanced', 'relaxed']),
    excludedUrls: z.array(z.string()),
    recordingSampleRate: z.number().min(0).max(1),
    recordingBlocked: z.boolean(),
    snapshot: z
      .object({
        pageGroupId: z.string().regex(/^[\w-]{1,64}$/),
        urlPattern: z.string().min(1),
        deviceClass: z.enum(['desktop', 'tablet', 'mobile']),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** `GET /health`. */
const panelHealthSchema = z
  .object({ ok: z.literal(true), service: z.literal('panel-ingest'), environment: z.string() })
  .strict();

/** `POST /v1/track` and `/v1/import`: how many events were stored and how many left out. */
const panelServerIngestSchema = z
  .object({ accepted: z.number().int().min(0), dropped: z.number().int().min(0) })
  .strict();

export const PANEL_ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/panel/projects', envelope: 'list', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id/settings', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects/:id/rotate-token', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id/install', envelope: 'single', data: panelInstallInfoSchema },
  // The collector (panel-ingest), registered where Rust serves it (`rustBasePath`).
  { method: 'GET', route: '/public/panel/health', envelope: 'body', data: panelHealthSchema },
  { method: 'GET', route: '/public/panel/c/:token', envelope: 'body', data: panelClientConfigSchema },
  { method: 'POST', route: '/public/panel/v1/track', envelope: 'body', data: panelServerIngestSchema },
  { method: 'POST', route: '/public/panel/v1/import', envelope: 'body', data: panelServerIngestSchema },
];
