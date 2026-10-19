import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { masterDb } from '@weldsuite/db/lib/master';
import { workspaces } from '@weldsuite/db/schema/master';
import { getTenantDbByWorkspaceId } from '@weldsuite/db/lib/tenant';
import * as personalSchema from '@weldsuite/db/schema/personal';

function stripUnsupportedParams(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return url;
  }
}

const personalConnectionString = stripUnsupportedParams(
  process.env.DATABASE_URL_PERSONAL || process.env.PERSONAL_DATABASE_URL,
);

const globalForPersonalDb = globalThis as unknown as {
  personalSql: ReturnType<typeof postgres> | undefined;
};

function getPersonalSql() {
  if (!personalConnectionString) {
    throw new Error('DATABASE_URL_PERSONAL (or PERSONAL_DATABASE_URL) is not set');
  }
  if (!globalForPersonalDb.personalSql) {
    globalForPersonalDb.personalSql = postgres(personalConnectionString, { max: 1 });
  }
  return globalForPersonalDb.personalSql;
}

export type PersonalPortalDb = PostgresJsDatabase<typeof personalSchema>;

export function getPersonalDb(): PersonalPortalDb {
  return drizzle({ client: getPersonalSql(), schema: personalSchema });
}

/** Workspace slugs: lowercase letters, digits and dashes (see workspace-worker onboard). */
const WORKSPACE_SLUG = /^[a-z0-9-]{1,100}$/;

/**
 * Resolve a tenant database connection from a workspace slug.
 *
 * Supports both:
 *  - Full workspace slug (e.g., "acme-corp-1704067200") — exact match
 *  - Clerk org slug (e.g., "acme-corp") — the one legacy "{slug}-{timestamp}" workspace, if exactly one exists
 */
export async function getTenantDbBySlug(rawSlug: string) {
  // The slug comes straight from the public URL. Only the workspace-slug
  // charset is accepted, so nothing in it can act as a LIKE or regex
  // metacharacter below, and nothing else ever reaches the master DB.
  const slug = rawSlug.trim().toLowerCase();
  if (!WORKSPACE_SLUG.test(slug)) return null;

  const columns = {
    id: workspaces.id,
    name: workspaces.name,
    slug: workspaces.slug,
    isActive: workspaces.isActive,
    clerkOrgId: workspaces.clerkOrgId,
    imageUrl: workspaces.imageUrl,
  };

  // Try exact match first
  let [workspace] = await masterDb.select(columns).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);

  // Fallback for legacy workspace slugs "{clerkOrgSlug}-{timestamp}", reached
  // through the Clerk org slug. Only that exact shape matches (a 10-13 digit
  // timestamp suffix, not any slug that merely starts with this one), and only
  // when it is unambiguous: a public URL must never land on whichever tenant
  // happens to share a prefix.
  if (!workspace) {
    const legacy = await masterDb
      .select(columns)
      .from(workspaces)
      .where(sql`${workspaces.slug} ~ ${`^${slug}-[0-9]{10,13}$`}`)
      .limit(2);
    workspace = legacy.length === 1 ? legacy[0] : undefined;
  }

  if (!workspace?.isActive) return null;

  try {
    const { db } = await getTenantDbByWorkspaceId(workspace.id);
    return { db, workspace };
  } catch (err) {
    console.error('[booking-portal] getTenantDbByWorkspaceId failed for', workspace.id, err);
    return null;
  }
}
