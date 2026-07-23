'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { parseCatalog, type CatalogInput, type ParsedCatalog } from '@/lib/apps-validation';
import { APP_CATALOG_SEED } from '@/lib/apps-seed-data';
import type { AppCatalogEntry } from '@/lib/apps-data';

const { appCatalog } = masterSchema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function serialize(row: typeof appCatalog.$inferSelect): AppCatalogEntry {
  return {
    ...row,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function refreshAppRoutes(id?: string): void {
  revalidatePath('/apps');
  if (id) revalidatePath(`/apps/${id}`);
}

export async function createApp(input: CatalogInput): Promise<ActionResult<AppCatalogEntry>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const parsed = parseCatalog(input);
  if (!parsed.ok) return { ok: false, error: parsed.message };
  const data = parsed.data as ParsedCatalog;

  const db = getMasterDb();
  const [existing] = await db
    .select({ id: appCatalog.id })
    .from(appCatalog)
    .where(eq(appCatalog.code, data.code));
  if (existing) return { ok: false, error: `App with code "${data.code}" already exists` };

  const [created] = await db
    .insert(appCatalog)
    .values({ id: generateId('app'), ...data })
    .returning();

  refreshAppRoutes();
  return { ok: true, data: serialize(created!) };
}

export async function updateApp(
  id: string,
  patch: CatalogInput,
): Promise<ActionResult<AppCatalogEntry>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const parsed = parseCatalog(patch, { partial: true });
  if (!parsed.ok) return { ok: false, error: parsed.message };
  const data = parsed.data;

  const db = getMasterDb();
  const [current] = await db.select().from(appCatalog).where(eq(appCatalog.id, id));
  if (!current) return { ok: false, error: 'App catalog entry not found' };

  if (data.code && data.code !== current.code) {
    const [dupe] = await db
      .select({ id: appCatalog.id })
      .from(appCatalog)
      .where(and(eq(appCatalog.code, data.code), ne(appCatalog.id, id)));
    if (dupe) return { ok: false, error: `App with code "${data.code}" already exists` };
  }

  const [updated] = await db
    .update(appCatalog)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(appCatalog.id, id))
    .returning();

  refreshAppRoutes(id);
  return { ok: true, data: serialize(updated!) };
}

export async function deleteApp(id: string): Promise<ActionResult<{ id: string }>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const db = getMasterDb();
  const [existing] = await db
    .select({ id: appCatalog.id })
    .from(appCatalog)
    .where(eq(appCatalog.id, id));
  if (!existing) return { ok: false, error: 'App catalog entry not found' };

  await db.delete(appCatalog).where(eq(appCatalog.id, id));
  refreshAppRoutes(id);
  return { ok: true, data: { id } };
}

export interface SeedAppsResult {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
  mode: 'upsert' | 'insertMissing';
}

export async function seedApps(
  mode: 'upsert' | 'insertMissing' = 'upsert',
): Promise<ActionResult<SeedAppsResult>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const resolvedMode: 'upsert' | 'insertMissing' = mode === 'insertMissing' ? 'insertMissing' : 'upsert';

  const db = getMasterDb();
  const codes = APP_CATALOG_SEED.map((a) => a.code);
  const existing = codes.length
    ? await db
        .select({
          id: appCatalog.id,
          code: appCatalog.code,
          isActive: appCatalog.isActive,
          isPublished: appCatalog.isPublished,
        })
        .from(appCatalog)
        .where(inArray(appCatalog.code, codes))
    : [];
  const byCode = new Map(existing.map((row) => [row.code, row]));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date();

  for (const seed of APP_CATALOG_SEED) {
    const current = byCode.get(seed.code);
    const releasedAt = seed.releasedAt ? new Date(seed.releasedAt) : null;

    if (!current) {
      await db.insert(appCatalog).values({
        id: generateId('app'),
        code: seed.code,
        name: seed.name,
        description: seed.description,
        icon: seed.icon,
        category: seed.category,
        path: seed.path,
        overview: seed.overview,
        features: seed.features,
        howItWorks: seed.howItWorks,
        isActive: true,
        isPublished: true,
        sortOrder: seed.sortOrder,
        version: seed.version,
        provider: seed.provider,
        verified: seed.verified,
        releasedAt,
        websiteUrl: seed.websiteUrl,
        documentationUrl: seed.documentationUrl,
        contactUrl: seed.contactUrl,
      });
      inserted++;
      continue;
    }

    if (resolvedMode === 'insertMissing') {
      skipped++;
      continue;
    }

    await db
      .update(appCatalog)
      .set({
        name: seed.name,
        description: seed.description,
        icon: seed.icon,
        category: seed.category,
        path: seed.path,
        overview: seed.overview,
        features: seed.features,
        howItWorks: seed.howItWorks,
        sortOrder: seed.sortOrder,
        version: seed.version,
        provider: seed.provider,
        verified: seed.verified,
        releasedAt,
        websiteUrl: seed.websiteUrl,
        documentationUrl: seed.documentationUrl,
        contactUrl: seed.contactUrl,
        updatedAt: now,
      })
      .where(eq(appCatalog.id, current.id));
    updated++;
  }

  refreshAppRoutes();
  return {
    ok: true,
    data: { inserted, updated, skipped, total: APP_CATALOG_SEED.length, mode: resolvedMode },
  };
}
