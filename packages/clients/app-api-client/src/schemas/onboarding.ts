import { z } from 'zod';

// ============================================================================
// Onboarding: /api/onboarding (session only, no workspace needed).
//
//   POST /create-workspace  an additional workspace (workspace worker)
//   POST /partner-request   ask the country's reseller for a workspace
//   GET  /status            has the active workspace completed onboarding?
//   GET  /database-status   tenant DB provisioning progress (poll target)
//   GET  /user-info         Clerk user basics + the active workspace's name
//   GET  /available-apps    the published app catalog (static fallback)
//   POST /profile, /role    Clerk user name and metadata
//   POST /workspace         the first workspace (workspace worker)
//   POST /invitations       Clerk org invitations to teammates
//   POST /complete          the remaining user / org metadata
//   POST /retry             re-trigger provisioning
//   POST /finalize          mark onboarding complete, install the picked apps
//
// Response schemas (the `data` of each `{ data }` envelope), for clients and
// the conformance suite.
// ============================================================================

/** `{ success: true }`: /profile, /role, /retry and /finalize. */
export const onboardingOkSchema = z.object({ success: z.literal(true) });

/**
 * POST /create-workspace and POST /workspace. The ids come from the workspace
 * worker and are left out when it sends none.
 */
export const onboardingWorkspaceCreatedSchema = z.object({
  success: z.literal(true),
  /** The new workspace's Clerk org id. */
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  /** A warm database slot made the workspace usable at once (no polling). */
  ready: z.boolean(),
});

/** POST /partner-request (201): the filed request. */
export const onboardingPartnerRequestSchema = z.object({ id: z.string() });

export const onboardingStatusSchema = z.object({
  completed: z.boolean(),
  hasOrganization: z.boolean(),
});

export const onboardingDatabaseStatusSchema = z.object({
  provisioned: z.boolean(),
  migrated: z.boolean(),
  /**
   * `ready` once provisioned, else the workspace's `provisioning_status`
   * (`pending`, `provisioning`, `failed`, `unavailable`, …; free text in the
   * database), `pending` without a workspace.
   */
  status: z.string(),
  failed: z.boolean(),
});

export const onboardingUserInfoSchema = z.object({
  user: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    /** Left out when Clerk has no image (or did not answer). */
    imageUrl: z.string().optional(),
  }),
  /** The active workspace, null without an org or a workspace row. */
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
});

/** An item of the static catalog GET /available-apps falls back to. */
export const onboardingFallbackAppSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string(),
    category: z.string(),
    path: z.string(),
  })
  .strict();

/** A published, active `app_catalog` row as GET /available-apps maps it. */
export const onboardingCatalogAppSchema = onboardingFallbackAppSchema
  .extend({
    overview: z.string().nullable(),
    features: z.array(z.string()).nullable(),
    howItWorks: z.array(z.object({ title: z.string(), description: z.string() })).nullable(),
    /** `1.0.0` when the row has none. */
    version: z.string(),
    provider: z.string().nullable(),
  })
  .strict();

/** An item of GET /available-apps: a catalog row, or the static fallback when there is none. */
export const onboardingAvailableAppSchema = z.union([onboardingCatalogAppSchema, onboardingFallbackAppSchema]);

/** POST /invitations: per-invite failures are listed, not fatal. */
export const onboardingInvitationsResultSchema = z.object({
  success: z.literal(true),
  sent: z.number().int(),
  failed: z.array(
    z.object({
      email: z.string(),
      /** Clerk's response text, or `Failed to send invitation` when it could not be reached. */
      error: z.string(),
    }),
  ),
});

/**
 * POST /complete: the session's org when it has one; else the workspace the
 * worker created (ids left out when it sends none).
 */
export const onboardingCompleteResultSchema = z.object({
  success: z.literal(true),
  clerkOrgId: z.string().optional(),
  workspaceId: z.string().optional(),
});

export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;
export type OnboardingDatabaseStatus = z.infer<typeof onboardingDatabaseStatusSchema>;
export type OnboardingUserInfo = z.infer<typeof onboardingUserInfoSchema>;
export type OnboardingAvailableApp = z.infer<typeof onboardingAvailableAppSchema>;
export type OnboardingWorkspaceCreated = z.infer<typeof onboardingWorkspaceCreatedSchema>;
export type OnboardingInvitationsResult = z.infer<typeof onboardingInvitationsResultSchema>;
export type OnboardingCompleteResult = z.infer<typeof onboardingCompleteResultSchema>;
