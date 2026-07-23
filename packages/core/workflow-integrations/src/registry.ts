/**
 * Provider registry — the single source of truth for which integrations
 * WeldConnect offers. Add a provider here and it automatically surfaces in the
 * builder's action/trigger pickers and the integrations marketplace.
 */

import type { IntegrationDef } from './types';
import { slack } from './providers/slack';
import { googleSheets } from './providers/google-sheets';
import { gmail } from './providers/gmail';
import { googleCalendar } from './providers/google-calendar';
import { microsoftTeams } from './providers/microsoft-teams';
import { twilio } from './providers/twilio';
import { notion } from './providers/notion';
import { airtable } from './providers/airtable';
import { github } from './providers/github';
import { asana } from './providers/asana';

const ALL: IntegrationDef[] = [
  slack,
  googleSheets,
  gmail,
  googleCalendar,
  microsoftTeams,
  twilio,
  notion,
  airtable,
  github,
  asana,
];

export const INTEGRATIONS: Record<string, IntegrationDef> = Object.fromEntries(
  ALL.map((def) => [def.id, def]),
);

export function getIntegrationDef(id: string): IntegrationDef | undefined {
  return INTEGRATIONS[id];
}

export function listIntegrations(): IntegrationDef[] {
  return ALL;
}

/** Find the integration that owns a namespaced action/trigger id
 *  (e.g. `slack.post_message` → the `slack` def). */
export function getIntegrationByItemId(itemId: string): IntegrationDef | undefined {
  const providerId = itemId.split('.')[0];
  return providerId ? INTEGRATIONS[providerId] : undefined;
}
