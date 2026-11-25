/**
 * Services outside the EU (`/api/outside-eu-services`, ADR OPS-026): which
 * non-EU services a workspace has switched on. On the EU edition each one is
 * off until a workspace admin switches it on, and the backend refuses calls
 * to one that is off (403 `OUTSIDE_EU_SERVICE_OFF`). Served by the Rust
 * backend only; Global does not offer the route. Zod v3.
 */

import { z } from 'zod';

export const outsideEuServiceIdSchema = z.enum([
  'telnyx',
  'cloudflare',
  'mailpool',
  'postpeer',
  'meta',
  'plaid',
  'stripe',
  'prospeo',
  'google',
  'microsoft',
  'slack',
  'discord',
  'hubspot',
  'attio',
  'github',
  'gitlab',
  'atlassian',
  'shopify',
  'twilio',
  'notion',
  'airtable',
  'asana',
]);
export type OutsideEuServiceId = z.infer<typeof outsideEuServiceIdSchema>;

/** Something in WeldSuite that calls the service. */
export const outsideEuUseSchema = z.object({
  /** The API module it belongs to. */
  module: z.string(),
  /** The key the platform names it by (`settings.outsideEu.uses.<key>`). */
  key: z.string(),
  /** English, from the backend: the fallback for an unknown key. */
  label: z.string(),
});
export type OutsideEuUse = z.infer<typeof outsideEuUseSchema>;

export const outsideEuServiceSchema = z.object({
  /** A known id, or one a newer backend added (shown by its `name`). */
  id: z.string(),
  name: z.string(),
  company: z.string(),
  /** ISO 3166-1 alpha-2. */
  country: z.string(),
  /** What leaves the EU, in English. */
  data: z.string(),
  /** Whose account the calls use: WeldSuite's, or one the workspace connects. */
  account: z.enum(['weldsuite', 'workspace']),
  uses: z.array(outsideEuUseSchema),
  enabled: z.boolean(),
  enabledBy: z.string().nullable().optional(),
  enabledByName: z.string().nullable().optional(),
  enabledAt: z.string().nullable().optional(),
  acknowledgedAt: z.string().nullable().optional(),
  /** Who switched it: an admin here, WeldSuite staff, or the move from Global. */
  via: z.enum(['admin', 'staff', 'move']).nullable().optional(),
  disabledBy: z.string().nullable().optional(),
  disabledByName: z.string().nullable().optional(),
  disabledAt: z.string().nullable().optional(),
});
export type OutsideEuService = z.infer<typeof outsideEuServiceSchema>;

export const outsideEuServicesSchema = z.object({
  /** True on the EU edition: a service that is off is never called. */
  enforced: z.boolean(),
  /** `settings:manage`: may switch services on and off. */
  canManage: z.boolean(),
  settingsPath: z.string(),
  services: z.array(outsideEuServiceSchema),
  /** Integration code (`gmail`, `azure_devops`, …) → the service it sends data to. */
  integrations: z.record(z.string()),
});
export type OutsideEuServices = z.infer<typeof outsideEuServicesSchema>;

export const switchOutsideEuServiceSchema = z.object({
  enabled: z.boolean(),
  /** Required (true) to switch one on. */
  acknowledgedOutsideEu: z.boolean().optional(),
});
export type SwitchOutsideEuServiceInput = z.infer<typeof switchOutsideEuServiceSchema>;

/** The error code of a call to a service the workspace hasn't switched on. */
export const OUTSIDE_EU_SERVICE_OFF = 'OUTSIDE_EU_SERVICE_OFF';
