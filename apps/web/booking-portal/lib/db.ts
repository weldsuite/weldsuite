import { eq, like, desc } from 'drizzle-orm';
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

/**
 * Resolve a tenant database connection from a workspace slug.
 *
 * Supports both:
 *  - Full workspace slug (e.g., "acme-corp-1704067200") — exact match
 *  - Clerk org slug (e.g., "acme-corp") — prefix match on "{slug}-*"
 */
export async function getTenantDbBySlug(slug: string) {
  // Try exact match first
  let [workspace] = await masterDb
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      isActive: workspaces.isActive,
      imageUrl: workspaces.imageUrl,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);

  // Fallback: prefix match for Clerk org slugs (workspace slug = "{clerkOrgSlug}-{timestamp}")
  if (!workspace) {
    [workspace] = await masterDb
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        isActive: workspaces.isActive,
        imageUrl: workspaces.imageUrl,
      })
      .from(workspaces)
      .where(like(workspaces.slug, `${slug}-%`))
      .orderBy(desc(workspaces.createdAt))
      .limit(1);
  }

  if (!workspace || !workspace.isActive) return null;

  try {
    const { db } = await getTenantDbByWorkspaceId(workspace.id);
    return { db, workspace };
  } catch (err) {
    console.error('[booking-portal] getTenantDbByWorkspaceId failed for', workspace.id, err);
    return null;
  }
}
