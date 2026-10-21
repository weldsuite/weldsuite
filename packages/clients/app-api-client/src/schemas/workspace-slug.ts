import { z } from 'zod';

// ============================================================================
// Workspace slug rules, shared by every place that sets a slug: the slug
// update in app-api, onboarding and partner onboarding in workspace-worker,
// and the platform's slug settings card.
//
// A slug names its workspace in platform URLs (`/{slug}/weldcrm/…`, see
// docs/plans/workspace-slug-first-urls.md), in help-center and booking
// subdomains, and in `{slug}.weldmail.com`. So it must never be a word the
// platform itself uses at the root of a URL.
// ============================================================================

export const SLUG_REGEX = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Names no workspace can claim. Only names that `SLUG_REGEX` could match are
 * listed: shorter ones (`w`, `w9`) and file names with a dot can never be
 * slugs anyway.
 *
 * `apps/web/platform/lib/reserved-workspace-slugs.test.ts` fails when a
 * top-level platform route or `public/` entry is missing here. Adding a name
 * makes an existing workspace that already uses it fall back to org-id URLs,
 * so run the collision query in the plan before adding one.
 */
export const RESERVED_WORKSPACE_SLUGS: readonly string[] = [
  // Platform infrastructure and subdomains.
  'www',
  'app',
  'api',
  'admin',
  'mail',
  'support',
  'help',
  // Top-level platform routes (apps/web/platform/src/routes), modules included.
  'agents',
  'apps',
  'appstore',
  'auth',
  'call-room',
  'documents',
  'invite',
  'new-chat',
  'objects',
  'onboarding',
  'preview',
  'settings',
  'social',
  'welcome',
  'weldads',
  'weldbooks',
  'weldcalendar',
  'weldcall',
  'weldchat',
  'weldcommerce',
  'weldconnect',
  'weldcrm',
  'welddata',
  'welddesk',
  'welddrive',
  'weldflow',
  'weldhost',
  'weldhr',
  'weldknow',
  'weldmail',
  'weldmeet',
  'weldpass',
  'weldreach',
  'weldstash',
  // Folders at the platform root (apps/web/platform/public): Cloudflare Pages
  // serves them before the app, so a workspace with one of these names would
  // never load.
  'assets',
  'email',
  'logos',
  'models',
  'sounds',
];

const RESERVED = new Set(RESERVED_WORKSPACE_SLUGS);

/** Whether a workspace may not use `slug`. Other `weld…` slugs are allowed. */
export function isReservedWorkspaceSlug(slug: string): boolean {
  return RESERVED.has(slug.toLowerCase());
}

/** A slug a workspace can set: the format, and not a reserved name. */
export const workspaceSlugSchema = z
  .string()
  .min(3, 'Slug must be at least 3 characters')
  .max(63, 'Slug must be at most 63 characters')
  .regex(
    SLUG_REGEX,
    'Slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens',
  )
  .refine((value) => !isReservedWorkspaceSlug(value), {
    message: 'This slug is reserved',
  });
