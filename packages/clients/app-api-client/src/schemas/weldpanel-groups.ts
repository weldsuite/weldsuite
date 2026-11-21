/**
 * WeldPanel group analytics: group types and group profiles. Zod v3 inputs,
 * plain interfaces for outputs.
 *
 * The SDKs call `group('company', 'acme', props)`; events then carry the
 * property `$group_company: 'acme'` and the group's profile lives in the
 * project's Durable Object (`PanelGroup` in `@weldsuite/panel-domain/project-object`).
 * A project collects at most {@link PANEL_MAX_GROUP_TYPES} types: a type takes
 * a slot the first time data names it, or when it is created here.
 *
 * Routes (all under `/api/panel`):
 *
 *   GET    /group-types?projectId                    → PanelGroupTypeDto[] (`panel_reports:read`)
 *   POST   /group-types                              → PanelGroupTypeDto (`panel_reports:create`)
 *   PATCH  /group-types/:id                          → PanelGroupTypeDto (`panel_reports:update`)
 *   DELETE /group-types/:id                          → 204, frees the type's slot (`panel_reports:delete`)
 *   GET    /groups?projectId&type&search&cursor&limit → PanelGroupDto[] (`panel_people:read`)
 *   GET    /groups/:type/:key?projectId&days          → PanelGroupProfileDto (`panel_people:read`)
 *   DELETE /groups/:type/:key?projectId               → 204 (`panel_people:delete`)
 */

import { z } from 'zod';
import { PANEL_PROPERTY_KEY, panelGroupTypeSchema } from './weldpanel-query';
import type { PanelActivityEvent, PanelPropertyScalar } from './weldpanel-objects';

/** Copy of the collector's `MAX_GROUP_TYPES` (wire.ts): group types one project collects. */
export const PANEL_MAX_GROUP_TYPES = 5;
/** Copy of the collector's `MAX_GROUP_KEY` (wire.ts). */
export const PANEL_MAX_GROUP_KEY = 255;

const projectId = z.string().min(1).max(30);
const groupName = z.string().trim().min(1).max(100);

/** A group key (`acme`, a company id): 1 to 255 characters, no control characters. */
export const panelGroupKeySchema = z
  .string()
  .min(1)
  .max(PANEL_MAX_GROUP_KEY)
  .refine((v) => [...v].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f), { message: 'Not a valid group key' });

/** The group profile property matched against WeldCRM companies (`domain`, `name`, `$name`). */
export const panelGroupMatchPropertySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((v) => PANEL_PROPERTY_KEY.test(v.startsWith('$') ? v.slice(1) : v), { message: 'Not a valid property key' });

// ---------------------------------------------------------------------------
// Group types
// ---------------------------------------------------------------------------

export const createPanelGroupTypeSchema = z.object({
  projectId,
  groupType: panelGroupTypeSchema,
  nameSingular: groupName,
  namePlural: groupName,
  crmMatchProperty: panelGroupMatchPropertySchema.nullish(),
});
export type CreatePanelGroupTypeInput = z.input<typeof createPanelGroupTypeSchema>;
export type ParsedCreatePanelGroupTypeInput = z.output<typeof createPanelGroupTypeSchema>;

/** The names and the CRM match; the type itself never changes (delete and create instead). */
export const updatePanelGroupTypeSchema = z
  .object({
    nameSingular: groupName.optional(),
    namePlural: groupName.optional(),
    crmMatchProperty: panelGroupMatchPropertySchema.nullish(),
  })
  .refine((v) => v.nameSingular !== undefined || v.namePlural !== undefined || v.crmMatchProperty !== undefined, {
    message: 'Nothing to change',
  });
export type UpdatePanelGroupTypeInput = z.input<typeof updatePanelGroupTypeSchema>;
export type ParsedUpdatePanelGroupTypeInput = z.output<typeof updatePanelGroupTypeSchema>;

export const panelGroupTypeListQuerySchema = z.object({ projectId });

/**
 * A group type of a project: a configured row (`panel_group_types`), a type
 * the project collects without one (`id: null`, names derived from the type),
 * or both.
 */
export interface PanelGroupTypeDto {
  /** Null for a type the project collects that nobody configured. */
  id: string | null;
  projectId: string;
  groupType: string;
  nameSingular: string;
  namePlural: string;
  /** Group property matched against WeldCRM companies; null = no CRM link. */
  crmMatchProperty: string | null;
  /** Has a `panel_group_types` row. */
  configured: boolean;
  /** Holds one of the project's slots: its operations and `$group_<type>` properties are kept. */
  collecting: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const panelGroupListQuerySchema = z.object({
  projectId,
  type: panelGroupTypeSchema,
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(500).nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PanelGroupListParams = z.input<typeof panelGroupListQuerySchema>;

export const panelGroupProfileQuerySchema = z.object({
  projectId,
  /** Look back this many days for events, members and the count. */
  days: z.coerce.number().int().min(7).max(365).default(90),
});
export type PanelGroupProfileParams = z.input<typeof panelGroupProfileQuerySchema>;

export const panelGroupDeleteQuerySchema = z.object({ projectId });

/** Shape of `PanelGroup` in `@weldsuite/panel-domain/project-object`, plus its display name. */
export interface PanelGroupDto {
  groupType: string;
  groupKey: string;
  /** The `$name` or `name` property, if set. */
  name: string | null;
  properties: Record<string, PanelPropertyScalar>;
  firstSeen: string;
  lastSeen: string;
}

/** A person whose events carried the group in the window. */
export interface PanelGroupMemberDto {
  distinctId: string;
  lastSeen: string;
  eventCount: number;
}

/** The WeldCRM company the group matched on the type's `crmMatchProperty`. */
export interface PanelGroupCrmCompanyDto {
  id: string;
  name: string;
  /** The company's website host (`acme.com`), if it has one. */
  domain: string | null;
}

/** `GET /groups/:type/:key`: the profile, its recent events, members and CRM company. */
export interface PanelGroupProfileDto {
  projectId: string;
  group: PanelGroupDto;
  /**
   * False when the object has no profile for the group but events name it
   * (`group()` was never called with properties): `group` is then built from
   * the events, with no properties.
   */
  hasProfile: boolean;
  /** The window the events, members and counts cover. */
  days: number;
  /** Newest first, page leaves and identity links left out. */
  recentEvents: PanelActivityEvent[];
  /** Events in the window that carry the group. */
  eventCount: number;
  /** The most recently seen people (up to 50). */
  members: PanelGroupMemberDto[];
  /** Distinct people in the window. */
  memberCount: number;
  /**
   * Null when the type has no `crmMatchProperty`, the profile lacks that
   * property, nothing matches, or the caller cannot read WeldCRM companies.
   */
  crmCompany: PanelGroupCrmCompanyDto | null;
}
