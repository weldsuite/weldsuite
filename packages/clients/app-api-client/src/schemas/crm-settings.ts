/**
 * WeldCRM workspace settings (`/api/crm-settings`). Today: auto-add, which
 * puts the people a workspace really deals with into WeldCRM by itself (the
 * people it emails or who answer its email, the external people its members
 * invite to meetings, the helpdesk requesters its agents reply to), and can
 * link them to the company of their email domain. Served by the Rust backend
 * on the Kubernetes editions only; Global has no such route (`crm-auto-add`
 * in `GLOBAL_UNAVAILABLE_FEATURES`). Zod v3.
 */

import { z } from 'zod';

/** Where auto-added people come from; each can be switched off on its own. */
export const CRM_AUTO_ADD_SOURCES = ['email', 'meetings', 'helpdesk'] as const;
export type CrmAutoAddSource = (typeof CRM_AUTO_ADD_SOURCES)[number];

export const crmAutoAddSettingsSchema = z.object({
  /** On by default, until someone switches it off. */
  enabled: z.boolean(),
  /** Also link each person to the company of their email domain, creating it when needed. */
  createCompanies: z.boolean(),
  /** All on by default. */
  sources: z.object({
    email: z.boolean(),
    meetings: z.boolean(),
    helpdesk: z.boolean(),
  }),
});
export type CrmAutoAddSettings = z.infer<typeof crmAutoAddSettingsSchema>;

export const crmSettingsSchema = z.object({
  autoAdd: crmAutoAddSettingsSchema,
});
export type CrmSettings = z.infer<typeof crmSettingsSchema>;

/** `PUT /api/crm-settings`: only the keys given change. */
export const updateCrmSettingsSchema = z.object({
  autoAdd: z
    .object({
      enabled: z.boolean().optional(),
      createCompanies: z.boolean().optional(),
      sources: z
        .object({
          email: z.boolean().optional(),
          meetings: z.boolean().optional(),
          helpdesk: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type UpdateCrmSettingsInput = z.infer<typeof updateCrmSettingsSchema>;
