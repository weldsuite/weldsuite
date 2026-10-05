import { randomBase36 } from './id';

/**
 * Workspace slug rules. Mirrored from
 * packages/clients/app-api-client/src/schemas/workspace-settings.ts (this worker
 * does not depend on @weldsuite/app-api-client), keep the two in sync.
 */
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

const MAX_BASE_LENGTH = 40;
const FALLBACK_SLUG = 'workspace';
const SUFFIX_LENGTH = 5;

/**
 * Derive a workspace slug from its display name: "QA Test 2026-09-29" becomes
 * "qa-test-2026-09-29". The result always satisfies SLUG_REGEX and is never a
 * reserved slug. Uniqueness is the caller's job (see `withRandomSuffix`).
 */
export function slugifyWorkspaceName(name: string): string {
  let slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, '');

  if (!slug) return FALLBACK_SLUG;

  // Must lead with a letter and have at least 3 characters; reserved names get
  // the same prefix so "Admin" does not collide with the platform's own slugs.
  if (!/^[a-z]/.test(slug) || slug.length < 3 || RESERVED_SLUGS.includes(slug)) {
    slug = `${FALLBACK_SLUG}-${slug}`;
  }

  return SLUG_REGEX.test(slug) ? slug : FALLBACK_SLUG;
}

/** Append a short random lowercase alphanumeric suffix to a slug. */
export function withRandomSuffix(slug: string): string {
  return `${slug}-${randomBase36(SUFFIX_LENGTH)}`;
}
