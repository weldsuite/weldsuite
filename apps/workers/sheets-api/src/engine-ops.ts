/**
 * The engine work the spreadsheet routes do in process, as functions the
 * Rust backend calls (rust/docs/collab-rooms.md): on Kubernetes the
 * collab-rooms service serves them as the `SHEET_ENGINE` binding, and in
 * conformance mode the tests hand the same functions to the harness. Each
 * one is what the route it names computes, step for step; the routes
 * themselves keep calling the engine directly. A new workbook comes back as
 * the gzipped checkpoint `writeSnapshot` stores. A connected table's listing
 * reads the workspace's database, so that one needs the env (`sheetEngineFor`).
 */

import {
  EN_LOCALE,
  Engine,
  ImportError,
  NL_LOCALE,
  Sheet,
  Workbook,
  readSpreadsheet,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import type { SheetFileLocale } from '@weldsuite/app-api-client/schemas/sheets';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import type { Env } from './types';
import { newTabId } from './room/people';
import { exportEngine } from './room/sheet-room';
import { convertLegacyModel, readLegacyModel } from './services/legacy-project-sheet';
import { buildRefresh, type RefreshResult } from './services/data-sources/refresh';
import type { DataSourceRecord } from './services/data-sources/sources';

/** As in routes/sheets/index.ts. */
const MAX_IMPORT_CELLS = 250_000;
const IMPORT_ZIP_LIMITS = { maxEntrySize: 32 * 1024 * 1024, maxTotalSize: 64 * 1024 * 1024 };
const LOCALES = { en: EN_LOCALE, nl: NL_LOCALE } as const;

export type Refused = { ok: false; message: string; reason: string };

/** The bytes `writeSnapshot` (room/snapshot.ts) puts in R2 for a new sheet. */
export async function checkpoint(workbook: WorkbookSnapshot): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify({ revision: 0, workbook })]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * `POST /api/sheets`'s workbook: a copy of another sheet's live JSON without
 * its connected tables (`copyOf`), or one empty tab.
 */
async function newSheet(firstTabName?: string | null, copyJson?: string | null): Promise<{ ok: true; checkpoint: Uint8Array }> {
  let workbook: WorkbookSnapshot;
  if (copyJson) {
    const copied = JSON.parse(copyJson) as WorkbookSnapshot;
    workbook = { ...copied, sheets: copied.sheets.map(({ dataTables: _tables, ...tab }) => tab) };
  } else {
    const empty = new Workbook();
    empty.sheets.push(new Sheet(newTabId(), firstTabName ?? 'Sheet1'));
    workbook = empty.toJSON();
  }
  return { ok: true, checkpoint: await checkpoint(workbook) };
}

/** `POST /api/sheets/import`'s read of the file (`readSpreadsheet`), or its `ImportError`. */
async function importFile(
  fileName: string,
  bytes: Uint8Array,
  locale?: SheetFileLocale | null,
): Promise<{ ok: true; checkpoint: Uint8Array; warnings: unknown[] } | Refused> {
  try {
    const result = await readSpreadsheet(fileName, bytes, {
      locale: LOCALES[locale ?? 'en'],
      maxCells: MAX_IMPORT_CELLS,
      limits: IMPORT_ZIP_LIMITS,
      sheetId: () => newTabId(),
    });
    return { ok: true, checkpoint: await checkpoint(result.workbook), warnings: result.warnings };
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    return { ok: false, message: err.message, reason: err.code };
  }
}

/** `POST /api/sheets/convert`'s workbook from an old project sheet's bytes (`legacyWorkbook`). */
async function convertLegacy(
  fileName: string,
  bytes: Uint8Array | null,
  firstTabName: string,
): Promise<{ ok: true; checkpoint: Uint8Array } | Refused> {
  try {
    // An unreadable file opens empty (its bytes stay in storage); one too big to open is refused.
    const model = bytes
      ? await readLegacyModel(fileName, bytes, MAX_IMPORT_CELLS).catch((err: unknown) => {
          if (err instanceof ImportError && err.code === 'too_large') throw err;
          return null;
        })
      : null;
    const workbook = convertLegacyModel(model ?? { sheets: [], columnsBySheet: {}, rowsBySheet: {} }, {
      newTabId,
      now: Date.now(),
      firstTabName,
    });
    return { ok: true, checkpoint: await checkpoint(workbook) };
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    return { ok: false, message: err.message, reason: err.code };
  }
}

/** `GET /api/sheets/:id/versions/:versionId/export`'s .xlsx of a stored version's workbook. */
async function exportWorkbook(workbookJson: string, locale?: SheetFileLocale | null): Promise<Uint8Array> {
  const engine = Engine.fromSnapshot(JSON.parse(workbookJson) as WorkbookSnapshot);
  engine.recalcAll();
  const file = await exportEngine(engine, { format: 'xlsx', locale: locale ?? undefined });
  return file!.bytes;
}

export const sheetEngine = { newSheet, importFile, convertLegacy, exportWorkbook };

/** What a connected table's listing reads of its `sheet_data_sources` row. */
export type DataTableSource = Pick<DataSourceRecord, 'id' | 'objectType' | 'definition' | 'createdById'>;

/**
 * The data source routes' listing (`refreshNow`'s `buildRefresh`): what
 * `source` lists now, with the access of the person who connected it, or why
 * it cannot be refreshed. `workspaceId` is the Clerk org id, as in the room's
 * meta; `file` is the sheet's drive file.
 */
async function listDataTable(env: Env, workspaceId: string, source: DataTableSource, file: DriveFileRef): Promise<RefreshResult> {
  const db = await getTenantDbForWorkspace(env, workspaceId);
  return buildRefresh(db, source as DataSourceRecord, file);
}

/** `sheetEngine` with the functions that read the workspace's database through `env`. */
export function sheetEngineFor(env: Env) {
  return {
    ...sheetEngine,
    listDataTable: (workspaceId: string, source: DataTableSource, file: DriveFileRef) => listDataTable(env, workspaceId, source, file),
  };
}

/**
 * The engine shaped as a namespace binding (`ns.get(ns.idFromName(name))[method]`).
 * Tests that mock `getTenantDbForWorkspace` can leave `env` out.
 */
export function sheetEngineNamespace(env: Env = {} as Env) {
  const engine = sheetEngineFor(env);
  return { idFromName: (name: string) => ({ name }), get: () => engine };
}
