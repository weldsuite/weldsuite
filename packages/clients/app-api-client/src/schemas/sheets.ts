/**
 * WeldSheets — the contract between sheets-api and the platform. Zod v3.
 *
 * A spreadsheet is a WeldDrive file (`files`) plus a `sheets` row. These
 * routes create, list, rename and trash it and open a session on it; the
 * workbook itself only travels over the sheet's room socket (the
 * @weldsuite/sheets-engine collab protocol). See docs/plans/weldsheets.md.
 */

import { z } from 'zod';
import {
  SHEET_DATA_OBJECT_KEYS,
  checkSheetDataDefinition,
  sheetDataDefinitionSchema,
  type SheetDataObjectKey,
} from './sheet-data';

/** What a connected table lists (see ./sheet-data). */
export type SheetDataDefinition = z.infer<typeof sheetDataDefinitionSchema>;

/** MIME type of a spreadsheet's drive file (it has no file of its own to download). */
export const WELDSHEET_MIME_TYPE = 'application/vnd.weldsuite.spreadsheet';

/** Path of the room socket; the session ticket goes in `?ticket=`. */
export const SHEET_CONNECT_PATH = '/api/sheets/connect';

const sheetName = z.string().trim().min(1).max(255);

export const createSheetSchema = z.object({
  name: sheetName,
  folderId: z.string().nullish(),
  /** Name of the first tab, in the creator's language ("Sheet1", "Blad1"). */
  firstTabName: z.string().trim().min(1).max(100).optional(),
  /** A WeldFlow project the sheet belongs to (it then lives with the project, not in a folder). */
  projectId: z.string().min(1).max(255).optional(),
  /** Start as a copy of this sheet (as it is now, comments included). */
  copyFromSheetId: z.string().min(1).max(255).optional(),
});
export type CreateSheetInput = z.infer<typeof createSheetSchema>;

export const updateSheetSchema = z.object({
  name: sheetName,
});
export type UpdateSheetInput = z.infer<typeof updateSheetSchema>;

export const listSheetsQuerySchema = z.object({
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  /** A WeldFlow project's sheets instead of the ones that belong to no project. */
  projectId: z.string().min(1).max(255).optional(),
});
export type ListSheetsQuery = z.infer<typeof listSheetsQuerySchema>;

export type SheetRole = 'owner' | 'editor' | 'viewer';

/**
 * What the room lets this person do: `edit` everything; `comment` only add,
 * edit and delete their own comments and resolve or reopen discussions (a
 * viewer with `sheets:comment`); `view` nothing (any other op is refused).
 */
export type SheetSessionMode = 'edit' | 'comment' | 'view';

export interface SheetSummary {
  id: string;
  /** The backing drive file. */
  fileId: string;
  name: string;
  folderId: string | null;
  createdAt: string;
  /** Last change to the name or the content (content as of the room's last checkpoint). */
  updatedAt: string;
  createdById: string | null;
  updatedById: string | null;
  /** The caller's role on the drive file. */
  role: SheetRole;
  /** The caller may change it: the role allows it and they hold `sheets:update`. */
  canEdit: boolean;
}

export interface SheetSession {
  /** Single-use, valid for a minute: `${SHEET_CONNECT_PATH}?ticket=…` opens the room. */
  ticket: string;
  /** Same as `mode === 'edit'`. */
  canEdit: boolean;
  mode: SheetSessionMode;
  /** This person's colour in the room (cursor, selection, avatar). */
  color: string;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const versionName = z.string().trim().min(1).max(255);

/** `POST /api/sheets/:id/versions`: save the spreadsheet as it is now under a name. */
export const createSheetVersionSchema = z.object({ name: versionName });
export type CreateSheetVersionInput = z.infer<typeof createSheetVersionSchema>;

/** `PATCH /api/sheets/:id/versions/:versionId`: rename a version. */
export const updateSheetVersionSchema = z.object({ name: versionName });
export type UpdateSheetVersionInput = z.infer<typeof updateSheetVersionSchema>;

/** `GET /api/sheets/:id/versions`: newest first; `cursor` is the previous page's `pagination.cursor`. */
export const listSheetVersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(255).optional(),
});
export type ListSheetVersionsQuery = z.infer<typeof listSheetVersionsQuerySchema>;

/** A saved copy of a spreadsheet at one revision. */
export interface SheetVersion {
  id: string;
  sheetId: string;
  /** The room's revision the copy is at. */
  revision: number;
  /** Null for an automatic version (the spreadsheet as it was before a restore). */
  name: string | null;
  /** Size of the stored snapshot, bytes. */
  size: number;
  createdAt: string;
  createdById: string | null;
}

/** `GET /api/sheets/:id/versions/:versionId/snapshot`: the workbook as the version saved it. */
export interface SheetVersionSnapshot<Snapshot = unknown> {
  revision: number;
  snapshot: Snapshot;
}

/** `POST /api/sheets/:id/versions/:versionId/restore`. */
export interface SheetRestoreResult {
  /** The spreadsheet's revision after the restore: the room's revision before it, plus one. */
  revision: number;
  /** The spreadsheet as it was just before the restore, saved as an automatic version. */
  autoVersion: SheetVersion;
}

// ---------------------------------------------------------------------------
// Files: import (.xlsx, .csv, .tsv) and export (.xlsx, .csv)
// ---------------------------------------------------------------------------

/** Largest file `POST /api/sheets/import` takes. */
export const SHEET_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

/** Language a file's dates and numbers are read in (CSV values, Excel's built-in date format). */
export const sheetFileLocaleSchema = z.enum(['en', 'nl']);
export type SheetFileLocale = z.infer<typeof sheetFileLocaleSchema>;

/**
 * Import a file already in WeldDrive as a new spreadsheet (JSON body). An
 * upload goes as multipart/form-data instead: `file`, and optionally `name`,
 * `folderId` and `locale`.
 */
export const importDriveFileSchema = z.object({
  fileId: z.string().min(1),
  name: sheetName.optional(),
  folderId: z.string().nullish(),
  locale: sheetFileLocaleSchema.optional(),
});
export type ImportDriveFileInput = z.infer<typeof importDriveFileSchema>;

/** What an import could not bring over (the spreadsheet is created without it). */
export const SHEET_IMPORT_WARNINGS = [
  'formulas',
  'conditionalFormats',
  'validations',
  'filters',
  'drawings',
  'comments',
  'pivotTables',
  'tables',
  'chartSheets',
  'macros',
  'externalLinks',
  'richText',
] as const;
export type SheetImportWarning = (typeof SHEET_IMPORT_WARNINGS)[number];

export interface SheetImportResult {
  sheet: SheetSummary;
  warnings: SheetImportWarning[];
}

/** Why an import was refused (the error's `details.reason`). */
export type SheetImportFailure = 'not_spreadsheet' | 'too_large' | 'corrupt' | 'unsupported' | 'empty';

export const exportSheetQuerySchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  /** The tab a CSV holds (default the first visible one). */
  tab: z.string().min(1).max(64).optional(),
  locale: sheetFileLocaleSchema.optional(),
});
export type ExportSheetQuery = z.input<typeof exportSheetQuerySchema>;

// ---------------------------------------------------------------------------
// Connected tables: live WeldSuite data in a spreadsheet
// ---------------------------------------------------------------------------

export const SHEET_DATA_REFRESH = ['manual', 'hourly', 'daily'] as const;
export type SheetDataRefresh = (typeof SHEET_DATA_REFRESH)[number];

/**
 * Why a refresh did not happen (`lastError`): the definition no longer fits
 * the object, the person who connected it may no longer read the object or
 * change the sheet, or listing failed.
 */
export type SheetDataRefreshError = 'invalid' | 'no_permission' | 'no_access' | 'failed' | 'unplaced';

/** `POST /api/sheets/:id/data-sources`: connect a table, written at `target` (a tab's cell) by its first refresh. */
export const createSheetDataSourceSchema = z
  .object({
    objectType: z.enum(SHEET_DATA_OBJECT_KEYS),
    definition: sheetDataDefinitionSchema,
    refresh: z.enum(SHEET_DATA_REFRESH).default('manual'),
    target: z.object({ tabId: z.string().min(1).max(200), row: z.number().int().min(0), col: z.number().int().min(0) }),
  })
  .superRefine((v, ctx) => {
    const problem = checkSheetDataDefinition(v.objectType, v.definition);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definition'], message: problem });
  });
export type CreateSheetDataSourceInput = z.input<typeof createSheetDataSourceSchema>;

/** `PATCH /api/sheets/:id/data-sources/:sourceId`: change what it lists or when it refreshes (it refreshes right after). */
export const updateSheetDataSourceSchema = z.object({
  definition: sheetDataDefinitionSchema.optional(),
  refresh: z.enum(SHEET_DATA_REFRESH).optional(),
});
export type UpdateSheetDataSourceInput = z.input<typeof updateSheetDataSourceSchema>;

export interface SheetDataSource {
  id: string;
  sheetId: string;
  objectType: SheetDataObjectKey;
  definition: SheetDataDefinition;
  refresh: SheetDataRefresh;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  lastError: SheetDataRefreshError | null;
  /** Records the last refresh wrote. */
  rowCount: number;
  /** Refreshes list only what this person may read. */
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/sheets/:id/data-sources/:sourceId/refresh` (and what create and update answer). */
export interface SheetDataRefreshResult {
  source: SheetDataSource;
  /** False when the refresh did not happen; `source.lastError` says why. */
  refreshed: boolean;
}

/** `POST /api/sheets/convert`: a WeldFlow project sheet from before WeldSheets, made a spreadsheet in place (on first open). */
export const convertProjectSheetSchema = z.object({
  fileId: z.string().min(1).max(255),
  /** Name of the tab an old sheet that was never saved starts with, in the opener's language. */
  firstTabName: z.string().trim().min(1).max(100).optional(),
});
export type ConvertProjectSheetInput = z.infer<typeof convertProjectSheetSchema>;
