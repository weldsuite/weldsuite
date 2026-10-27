/**
 * WeldPanel — the contract between panel-api and the platform. Zod v3.
 *
 * Phase 1 (docs/plans/weldpanel.md): projects, their token and settings, and
 * the install check. Reports, recordings and people build on the same module.
 *
 * The enums and the settings shape mirror
 * `packages/core/db/src/schema/weldpanel.ts`; keep them in step.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const PANEL_PROJECT_KINDS = ['website', 'app'] as const;
export type PanelProjectKind = (typeof PANEL_PROJECT_KINDS)[number];

export const PANEL_PROJECT_STATUSES = ['active', 'paused'] as const;
export type PanelProjectStatus = (typeof PANEL_PROJECT_STATUSES)[number];

export const PANEL_MASKING_LEVELS = ['strict', 'balanced', 'relaxed'] as const;
export type PanelMaskingLevel = (typeof PANEL_MASKING_LEVELS)[number];

export const PANEL_CONSENT_MODES = ['required', 'none'] as const;
export type PanelConsentMode = (typeof PANEL_CONSENT_MODES)[number];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A bare host (`example.com`, `shop.example.com`, `*.example.com`); no scheme, path or port. */
export const panelDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^localhost$/, 'Enter a host like example.com');

/** A path pattern (`/admin/*`, `/checkout/success`); `*` matches any characters. */
export const panelUrlPatternSchema = z.string().trim().min(1).max(200).regex(/^\//, 'Start with /');

export const panelSettingsSchema = z.object({
  autocapture: z.boolean(),
  maskingLevel: z.enum(PANEL_MASKING_LEVELS),
  consentMode: z.enum(PANEL_CONSENT_MODES),
  recordingSampleRate: z.number().min(0).max(1),
  excludedUrls: z.array(panelUrlPatternSchema).max(50),
  ipFilters: z.array(z.string().trim().min(1).max(64)).max(50),
  aiEnabled: z.boolean(),
});
export type PanelSettings = z.infer<typeof panelSettingsSchema>;

export const createPanelProjectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  kind: z.enum(PANEL_PROJECT_KINDS).default('website'),
  allowedDomains: z.array(panelDomainSchema).max(20).default([]),
});
export type CreatePanelProjectInput = z.input<typeof createPanelProjectSchema>;

/** Name and domains: `panel_projects:update`. */
export const updatePanelProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    kind: z.enum(PANEL_PROJECT_KINDS),
    allowedDomains: z.array(panelDomainSchema).max(20),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePanelProjectInput = z.input<typeof updatePanelProjectSchema>;

/** Collector and privacy settings, and pausing: `panel_projects:manage`. */
export const updatePanelProjectSettingsSchema = z
  .object({
    status: z.enum(PANEL_PROJECT_STATUSES),
    settings: panelSettingsSchema.partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePanelProjectSettingsInput = z.input<typeof updatePanelProjectSettingsSchema>;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface PanelProjectDto {
  id: string;
  name: string;
  kind: PanelProjectKind;
  status: PanelProjectStatus;
  /** Public project token (`wpk_…`). Shown to anyone who can read the project: it can only send data. */
  token: string;
  allowedDomains: string[];
  settings: PanelSettings;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** The install panel: snippets for this project and whether events have arrived. */
export interface PanelInstallInfo {
  projectId: string;
  token: string;
  /** Collector origin for this environment, e.g. `https://pnl.weldsuite.org`. */
  collectorUrl: string;
  /**
   * Ready to paste before `</head>`: a one-line stub that queues calls made
   * before the SDK loads, then `<script async src="…/s.js" data-project="wpk_…">`.
   */
  scriptSnippet: string;
  /** npm usage for apps that bundle the SDK. */
  npmSnippet: string;
  /** Last event the collector accepted (within a few minutes), or null if none yet. */
  lastEventAt: string | null;
  /** `receiving` when an event arrived in the last 24 hours. */
  status: 'waiting' | 'receiving';
}
