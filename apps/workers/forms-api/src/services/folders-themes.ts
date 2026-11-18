/**
 * Folders (group forms on the home page) and themes (the workspace's looks,
 * one of them the default).
 */

import { asc, eq, max, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { formThemeTokensSchema } from '@weldsuite/forms-engine/definition';
import type {
  CreateFormFolderInput,
  CreateFormThemeInput,
  FormFolder,
  FormTheme,
  UpdateFormFolderInput,
  UpdateFormThemeInput,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { notFound } from '../lib/errors';
import type { WorkspaceCtx } from './context';

const { forms, formFolders, formThemes, formSettings } = schema;

type FolderRow = typeof formFolders.$inferSelect;
type ThemeRow = typeof formThemes.$inferSelect;

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

const folderDto = (row: FolderRow, formCount: number): FormFolder => ({
  id: row.id,
  name: row.name,
  position: row.position,
  formCount,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listFolders(ctx: Pick<WorkspaceCtx, 'db'>): Promise<FormFolder[]> {
  const [rows, counts] = await Promise.all([
    ctx.db.select().from(formFolders).orderBy(asc(formFolders.position), asc(formFolders.name)),
    ctx.db.select({ folderId: forms.folderId, n: sql<number>`count(*)::int` }).from(forms).groupBy(forms.folderId),
  ]);
  const byFolder = new Map(counts.map((c) => [c.folderId, Number(c.n)]));
  return rows.map((r) => folderDto(r, byFolder.get(r.id) ?? 0));
}

export async function loadFolder(ctx: Pick<WorkspaceCtx, 'db'>, id: string): Promise<FolderRow> {
  const [row] = await ctx.db.select().from(formFolders).where(eq(formFolders.id, id)).limit(1);
  if (!row) throw notFound('Folder');
  return row;
}

export async function createFolder(ctx: Pick<WorkspaceCtx, 'db'>, input: CreateFormFolderInput): Promise<FormFolder> {
  const [last] = await ctx.db.select({ n: max(formFolders.position) }).from(formFolders);
  const [row] = await ctx.db
    .insert(formFolders)
    .values({ id: generateId('ffd'), name: input.name, position: (last?.n ?? -1) + 1 })
    .returning();
  return folderDto(row!, 0);
}

export async function updateFolder(ctx: Pick<WorkspaceCtx, 'db'>, folder: FolderRow, input: UpdateFormFolderInput): Promise<FormFolder> {
  const [row] = await ctx.db
    .update(formFolders)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      updatedAt: new Date(),
    })
    .where(eq(formFolders.id, folder.id))
    .returning();
  const [count] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(forms).where(eq(forms.folderId, folder.id));
  return folderDto(row ?? folder, Number(count?.n ?? 0));
}

/** Forms in the folder move to "no folder". */
export async function deleteFolder(ctx: Pick<WorkspaceCtx, 'db'>, folder: FolderRow): Promise<void> {
  await atomically(ctx.db, (db) => [
    db.update(forms).set({ folderId: null }).where(eq(forms.folderId, folder.id)),
    db.delete(formFolders).where(eq(formFolders.id, folder.id)),
  ]);
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const themeDto = (row: ThemeRow): FormTheme => ({
  id: row.id,
  name: row.name,
  tokens: formThemeTokensSchema.parse(row.tokens),
  isDefault: row.isDefault,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function listThemes(ctx: Pick<WorkspaceCtx, 'db'>): Promise<FormTheme[]> {
  const rows = await ctx.db.select().from(formThemes).orderBy(asc(formThemes.name), asc(formThemes.id));
  return rows.map(themeDto);
}

export async function loadTheme(ctx: Pick<WorkspaceCtx, 'db'>, id: string): Promise<ThemeRow> {
  const [row] = await ctx.db.select().from(formThemes).where(eq(formThemes.id, id)).limit(1);
  if (!row) throw notFound('Theme');
  return row;
}

/** One theme is the default: making another one so clears the flag elsewhere in the same step. */
export async function createTheme(ctx: Pick<WorkspaceCtx, 'db'>, userId: string, input: CreateFormThemeInput): Promise<FormTheme> {
  const id = generateId('fth');
  await atomically(ctx.db, (db) => [
    ...(input.isDefault ? [db.update(formThemes).set({ isDefault: false }).where(eq(formThemes.isDefault, true))] : []),
    db.insert(formThemes).values({ id, name: input.name, tokens: input.tokens, isDefault: input.isDefault ?? false, createdByUserId: userId }),
  ]);
  return themeDto(await loadTheme(ctx, id));
}

export async function updateTheme(ctx: Pick<WorkspaceCtx, 'db'>, theme: ThemeRow, input: UpdateFormThemeInput): Promise<FormTheme> {
  await atomically(ctx.db, (db) => [
    ...(input.isDefault ? [db.update(formThemes).set({ isDefault: false }).where(eq(formThemes.isDefault, true))] : []),
    db
      .update(formThemes)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        updatedAt: new Date(),
      })
      .where(eq(formThemes.id, theme.id)),
  ]);
  return themeDto(await loadTheme(ctx, theme.id));
}

/** Forms using the theme fall back to the default; published versions keep the snapshot they were made with. */
export async function deleteTheme(ctx: Pick<WorkspaceCtx, 'db'>, theme: ThemeRow): Promise<void> {
  await atomically(ctx.db, (db) => [
    db.update(forms).set({ themeId: null }).where(eq(forms.themeId, theme.id)),
    db.update(formSettings).set({ defaultThemeId: null }).where(eq(formSettings.defaultThemeId, theme.id)),
    db.delete(formThemes).where(eq(formThemes.id, theme.id)),
  ]);
}
