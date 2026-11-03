/** WeldPanel (panel-api) response schemas: projects and the install check. Spread into ROUTES by conformance-schemas.ts. */
import { panelInstallInfoSchema, panelProjectDtoSchema } from '@weldsuite/app-api-client/schemas/weldpanel';
import type { RouteSchema } from './conformance-schemas';

export const PANEL_ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/panel/projects', envelope: 'list', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'PATCH', route: '/api/panel/projects/:id/settings', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'POST', route: '/api/panel/projects/:id/rotate-token', envelope: 'single', data: panelProjectDtoSchema },
  { method: 'GET', route: '/api/panel/projects/:id/install', envelope: 'single', data: panelInstallInfoSchema },
];
