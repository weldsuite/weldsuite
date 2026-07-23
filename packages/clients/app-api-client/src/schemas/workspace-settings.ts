import { z } from 'zod';

// ============================================================================
// Workspace settings — name + slug mutations for the active workspace.
//
// Ported from core-api's `workspace.ts` schemas. These back two endpoints on
// the app-api `/api/workspace-settings` surface:
//   - PUT  /name   (owner OR admin)  → updateWorkspaceNameInput
//   - POST /slug   (owner only)      → updateWorkspaceSlugInput
//
// Both sync the change to the Clerk organization; a slug change additionally
// rewrites the help-center subdomain and invalidates the WORKSPACE_CACHE KV.
// ============================================================================

/** Slugs reserved for platform infrastructure — cannot be claimed by a workspace. */
const RESERVED_SLUGS = [
  'www',
  'app',
  'api',
  'admin',
  'mail',
  'welddesk',
  'weldmail',
  'support',
  'help',
];

export const SLUG_REGEX = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

export const updateWorkspaceSlugInput = z.object({
  slug: z
    .string()
    .min(3, 'Slug must be at least 3 characters')
    .max(63, 'Slug must be at most 63 characters')
    .regex(
      SLUG_REGEX,
      'Slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens',
    )
    .refine((value) => !RESERVED_SLUGS.includes(value), {
      message: 'This slug is reserved',
    }),
});

export type UpdateWorkspaceSlugInput = z.infer<typeof updateWorkspaceSlugInput>;

export interface WorkspaceSlugUpdated {
  id: string;
  slug: string;
  previousSlug: string;
}

export const updateWorkspaceNameInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(255, 'Name must be at most 255 characters'),
});

export type UpdateWorkspaceNameInput = z.infer<typeof updateWorkspaceNameInput>;

export interface WorkspaceNameUpdated {
  id: string;
  name: string;
}

// ============================================================================
// Workspace deletion — owner-only, irreversible.
//
//   GET    /deletion-status — what deleting the workspace would destroy
//   DELETE /                — permanently delete the active workspace
//
// The caller confirms by typing the workspace slug (guards against deleting
// the wrong workspace). Deletion cascades through the Clerk
// `organization.deleted` webhook (workspace soft-delete + Neon teardown); any
// active Stripe subscription is cancelled first so the owner isn't billed for
// a workspace that no longer exists.
// ============================================================================

export const deleteWorkspaceInput = z.object({
  /** Must equal the workspace slug — verified server-side. */
  confirmation: z.string().min(1),
});

export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceInput>;

export interface WorkspaceDeletionStatus {
  workspaceId: string;
  name: string;
  slug: string;
  /** Active members that will lose access when the workspace is deleted. */
  memberCount: number;
  /** True when a paid Stripe subscription will be cancelled on delete. */
  hasActiveSubscription: boolean;
}

export interface DeleteWorkspaceResult {
  deleted: boolean;
}

// ============================================================================
// Workspace settings blob — the `workspace_settings` business record.
//
//   GET /  — read the singleton row (null when never saved)
//   PUT /  — upsert it
//
// Ported from api-worker `GET|PUT /settings/workspace`. The PUT additionally
// fans out to the master `digest_schedules.timezone` and the Stripe customer
// record when any billing-relevant field is present.
//
// `name`, `locale`, `logo` and `settings` are accepted but NOT persisted: the
// `workspace_settings` table has no such columns, so the legacy route's
// `...data` spread silently dropped them. They stay in the schema so existing
// callers (app/settings/billing/page.tsx posts `{ settings: { business } }`)
// keep getting a 200 rather than a fresh 400. The authoritative mapping is
// `WRITABLE_BLOB_FIELDS` in apps/workers/app-api/src/services/workspace-settings.ts.
// ============================================================================

export const updateWorkspaceSettingsInput = z.object({
  // Accepted-and-ignored (no backing column) — see note above.
  name: z.string().optional(),
  locale: z.string().optional(),
  logo: z.string().optional(),
  settings: z.record(z.any()).optional(),

  // Localisation defaults.
  timezone: z.string().optional(),
  currency: z.string().optional(),
  language: z.string().optional(),
  dateFormat: z.string().optional(),
  timeFormat: z.string().optional(),
  theme: z.string().optional(),

  // Business information.
  legalName: z.string().nullable().optional(),
  tradingName: z.string().nullable().optional(),
  contactFirstName: z.string().nullable().optional(),
  contactLastName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),

  // Address.
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),

  // Tax / registration.
  vatNumber: z.string().nullable().optional(),
  registrationNumber: z.string().nullable().optional(),

  // Branding.
  logoUrl: z.string().nullable().optional(),
  websiteUrl: z.string().nullable().optional(),
  primaryColor: z.string().nullable().optional(),
  accentColor: z.string().nullable().optional(),

  // Extensible JSON bag (printnode integration settings live here).
  customSettings: z.record(z.unknown()).nullable().optional(),
});

export type UpdateWorkspaceSettingsInput = z.infer<typeof updateWorkspaceSettingsInput>;
