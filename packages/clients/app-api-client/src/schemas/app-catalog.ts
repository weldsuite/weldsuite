import { z } from 'zod';

// ============================================================================
// App catalog — first-party module store (master DB `app_catalog` table).
//
// Ported from the mobile-api-worker surface (`/v1/apps` catalog browse +
// `/v1/workspace` POST/DELETE `/apps` install/uninstall). Served by app-api
// at `/api/app-catalog`:
//
//   GET    /              — published apps + per-workspace isInstalled
//   GET    /categories    — distinct catalog categories
//   GET    /:code         — single app detail + installation info
//   POST   /:code/install — install (OWNER/ADMIN only)
//   DELETE /:code/install — uninstall / soft delete (OWNER/ADMIN only)
//
// The `:code` param accepts legacy mobile app codes (`helpdesk`, `mail`),
// and the catalog `code` field in GET / and GET /:code responses is
// translated back to those legacy codes (matching the mobile-api-worker
// original, so repointed mobile clients' legacy-code comparisons keep
// working). Install responses carry the canonical DB `appCode`.
//
// GET / and GET /:code accept `?codes=canonical` to opt out of that
// back-translation and receive the raw DB code (`welddesk`, `weldmail`) —
// used by the platform App Store, which is keyed on the canonical codes.
// ============================================================================

/** Optional body for POST /:code/install — app-specific settings JSON. */
export const installCatalogAppSchema = z.object({
  settings: z.record(z.any()).optional(),
});

export type InstallCatalogAppInput = z.infer<typeof installCatalogAppSchema>;

/** Catalog list/detail item as returned by GET / and GET /:code. */
export interface CatalogAppItem {
  id: string;
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview: string | null;
  features: string[];
  howItWorks: { title: string; description: string }[];
  version: string | null;
  provider: string | null;
  isInstalled: boolean;
  /** Store-listing fields (parity with api-worker GET /settings/available-apps). */
  verified: boolean;
  releasedAt: string | Date | null;
  websiteUrl: string | null;
  documentationUrl: string | null;
  contactUrl: string | null;
}

/** Installation metadata attached to GET /:code when installed. */
export interface CatalogAppInstallation {
  id: string;
  installedAt: string | Date | null;
  settings: Record<string, unknown> | null;
}
