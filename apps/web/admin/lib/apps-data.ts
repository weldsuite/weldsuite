import 'server-only';

import { eq, and, asc, ilike, or, sql } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';

const { appCatalog } = masterSchema;

export interface AppCatalogEntry {
  id: string;
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview: string | null;
  features: string[] | null;
  howItWorks: { title: string; description: string }[] | null;
  isActive: boolean;
  isPublished: boolean;
  sortOrder: number;
  version: string | null;
  provider: string | null;
  verified: boolean;
  releasedAt: string | null;
  websiteUrl: string | null;
  documentationUrl: string | null;
  contactUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppCatalogStats {
  total: number;
  active: number;
  published: number;
  inactive: number;
}

export interface AppListFilters {
  search?: string;
  category?: string;
  includeInactive?: boolean;
}

function serialize(row: typeof appCatalog.$inferSelect): AppCatalogEntry {
  return {
    ...row,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listApps(filters: AppListFilters = {}): Promise<AppCatalogEntry[]> {
  const db = getMasterDb();
  const conds = [];
  if (filters.includeInactive === false) conds.push(eq(appCatalog.isActive, true));
  if (filters.category) conds.push(eq(appCatalog.category, filters.category));
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conds.push(
      or(
        ilike(appCatalog.name, pattern),
        ilike(appCatalog.code, pattern),
        ilike(appCatalog.description, pattern),
      ),
    );
  }

  const rows = await db
    .select()
    .from(appCatalog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(appCatalog.sortOrder), asc(appCatalog.name));

  return rows.map(serialize);
}

export async function getAppStats(): Promise<AppCatalogStats> {
  const db = getMasterDb();
  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${appCatalog.isActive} = true)::int`,
      published: sql<number>`count(*) filter (where ${appCatalog.isPublished} = true)::int`,
      inactive: sql<number>`count(*) filter (where ${appCatalog.isActive} = false)::int`,
    })
    .from(appCatalog);

  return stats ?? { total: 0, active: 0, published: 0, inactive: 0 };
}

export async function getAppById(id: string): Promise<AppCatalogEntry | null> {
  const db = getMasterDb();
  const [row] = await db.select().from(appCatalog).where(eq(appCatalog.id, id));
  return row ? serialize(row) : null;
}
