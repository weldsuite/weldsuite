/**
 * SheetRoom — one Durable Object per spreadsheet (named `${workspaceId}:${sheetId}`),
 * the single place a sheet's edits are ordered (ADR SHEETS-003).
 *
 * Sockets, the op log, checkpoints and version restores are `CollabRoom`
 * from @weldsuite/collab (see there), run on the sheets engine
 * (@weldsuite/sheets-engine). This class adds what is particular to sheets:
 *
 *   - Checkpoints and versions are `{ revision, workbook }` objects in R2
 *     (snapshot.ts); the tenant DB's `sheets` row records each checkpoint,
 *     and a `sheet.updated` entity event reports the change.
 *   - Commenters (`canComment`) may only commit comment ops (comment-access.ts).
 *     A comment's text, and its mentions, are in the sheet's WeldChat chat.
 *   - Exports, and the reads and writes of agent tools, work on the live
 *     workbook.
 *   - Server writes: connected tables' refreshes and agent tools commit ops
 *     through `commitServerOp`, like anyone's edit. Scheduled refreshes run on
 *     this object's alarm, which it shares with checkpoints.
 *
 * The class is abstract over its tenant database: each host subclasses it
 * with `tenantDb`. sheets-api opens Neon through worker-kit (Global);
 * collab-rooms opens CloudNativePG on Node (the Kubernetes editions). Nothing
 * here imports worker-kit, which goes with the workers (ADR OPS-025).
 */

import { CollabRoom, type AdmittedPeer, type AutoVersion, type CheckpointRecord, type RestoreOutcome, type VersionRestore } from '@weldsuite/collab/durable-room';
import type * as collab from '@weldsuite/collab';
import {
  EN_LOCALE,
  NL_LOCALE,
  RoomCore,
  Sheet,
  Workbook,
  dataTableOp,
  readValues,
  resolveRef,
  sheetsAdapter,
  valuesOp,
  writeCsv,
  writeXlsx,
  type CellInput,
  type CommittedOp,
  type DataTableWrite,
  type Engine,
  type Op,
  type Presence,
  type Range,
  type ReadValues,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';
import type { TenantDb } from '@weldsuite/db/lib/any-db';
import { getSheet, recordCheckpoint } from '../services/sheets';
import { insertVersion, versionKeyFor } from '../services/versions';
import { buildRefresh } from '../services/data-sources/refresh';
import { dataSourceEventData, dueDataSources, nextDueAt, recordRefresh, type DataSourceRecord } from '../services/data-sources/sources';
import { readSnapshot, writeSnapshot } from './snapshot';
import { isCommentersOp } from './comment-access';

export { replyCode } from '@weldsuite/collab/durable-room';
export type { LiveSnapshot, RestoreOutcome, SavedVersion } from '@weldsuite/collab/durable-room';

/** The bindings a room reads, whichever host runs it. */
export interface SheetRoomEnv extends EntityEventPublisherEnv {
  /** Workbook checkpoints (private bucket, `workspaces/<org>/sheets/<id>/…`). */
  PRIVATE_STORAGE: R2Bucket;
}

/** Which sheet a room holds, and where its checkpoint is. */
export interface RoomMeta {
  /** Clerk org id (what worker-kit calls the workspace id). */
  workspaceId: string;
  sheetId: string;
  snapshotKey: string;
}

/**
 * What the session route tells the room: which sheet it is, and who is
 * coming in (`canComment`: may add comments without editing, ignored when
 * `canEdit`).
 */
export interface Admission extends RoomMeta, AdmittedPeer {
  picture: string | null;
  canComment: boolean;
}

/** What the restore route asks the room. */
export interface RestoreRequest extends VersionRestore {
  sheet: RoomMeta;
}

export interface ExportRequest {
  format: 'xlsx' | 'csv';
  /** The tab a CSV holds; default the first visible one. */
  tab?: string;
  locale?: 'en' | 'nl';
}

export interface ExportedFile {
  bytes: Uint8Array;
  /** The tab a CSV holds, for its file name. */
  tabName: string | null;
}

/** A tab of the workbook, and the cells it uses. */
export interface TabInfo {
  id: string;
  name: string;
  hidden: boolean;
  /** The used block in A1 notation, or null for an empty tab. */
  used: Range | null;
}

/** A range to read or write: a tab (id or name; default the first) and A1 text (default its used block). */
export interface RangeRequest {
  tab?: string;
  range?: string;
}

export type ReadResult = ({ ok: true; tabId: string; tabName: string } & ReadValues) | { ok: false; error: string };

export type WriteResult = { ok: true; revision: number; range: Range; tabId: string } | { ok: false; error: string };

/** Storage key: when the next scheduled refresh of a connected table is due (epoch ms). */
const REFRESH_AT = 'refreshAt';
/** Sheet id of the workbook a room starts from when its sheet has no checkpoint at all. */
const FALLBACK_SHEET_ID = 'sheet1';
/** Client id server writes commit under (refreshes, agent tools). */
const SERVER_CLIENT = 'server';
/** Cells an agent reads in one go at most. */
const MAX_READ_CELLS = 10_000;

/** Shape checks only: engine options do not matter here. */
const shapeChecks = sheetsAdapter();

export abstract class SheetRoom<E extends SheetRoomEnv = SheetRoomEnv> extends CollabRoom<E, RoomMeta, Engine, Op, WorkbookSnapshot, Presence, RoomCore> {
  protected readonly logPrefix = '[sheets-api/room]';
  protected readonly noun = 'sheet';
  protected readonly shapeChecks = shapeChecks;

  /** The tenant database of `workspaceId` (the room meta's, a Clerk org id or `workspaces.id`). */
  protected abstract tenantDb(workspaceId: string): Promise<TenantDb>;

  /** Registers a ticket for one connection (RPC from the session route). */
  async admit(admission: Admission): Promise<string> {
    const { workspaceId, sheetId, snapshotKey, ...peer } = admission;
    return this.issueTicket({ workspaceId, sheetId, snapshotKey }, peer);
  }

  /** Replaces the workbook with a saved version (RPC from the restore route; see `restoreTo`). */
  async restoreVersion(req: RestoreRequest): Promise<RestoreOutcome> {
    return this.restoreTo(req.sheet, req);
  }

  /**
   * The workbook as a file, written from the room's live state, edits not
   * yet checkpointed included (RPC from the export route). Null when the CSV's
   * tab does not exist.
   */
  async exportFile(sheet: RoomMeta, request: ExportRequest): Promise<ExportedFile | null> {
    const { engine } = await this.roomFor(sheet);
    return exportEngine(engine, request);
  }

  /** The workbook's tabs and the cells each uses (RPC for agent tools). */
  async tabs(sheet: RoomMeta): Promise<TabInfo[]> {
    const { engine } = await this.roomFor(sheet);
    return engine.workbook.sheets.map((s) => ({ id: s.id, name: s.name, hidden: !!s.props.hidden, used: engine.usedRange(s.id) }));
  }

  /** Values and formulas of a range, edits not checkpointed included (RPC for agent tools). */
  async readRange(sheet: RoomMeta, request: RangeRequest): Promise<ReadResult> {
    const { engine } = await this.roomFor(sheet);
    const at = target(engine, request);
    if (typeof at === 'string') return { ok: false, error: at };
    const range = at.range ?? engine.usedRange(at.tabId) ?? { r1: 0, c1: 0, r2: 0, c2: 0 };
    return { ok: true, tabId: at.tabId, tabName: at.tabName, ...readValues(engine, at.tabId, range, MAX_READ_CELLS) };
  }

  /**
   * Writes values from a range's top-left cell (RPC for agent tools), as an
   * edit by `userId` that everyone in the sheet sees at once.
   */
  async writeRange(sheet: RoomMeta, request: RangeRequest & { values: CellInput[][]; userId: string }): Promise<WriteResult> {
    const room = await this.roomFor(sheet);
    const at = target(room.engine, request);
    if (typeof at === 'string') return { ok: false, error: at };
    const start = at.range ? { row: at.range.r1, col: at.range.c1 } : { row: 0, col: 0 };
    const width = Math.max(0, ...request.values.map((r) => r.length));
    const range = { r1: start.row, c1: start.col, r2: start.row + request.values.length - 1, c2: start.col + width - 1 };
    const result = this.commit(room, valuesOp(at.tabId, start, request.values), request.userId);
    return result.ok ? { ok: true, revision: result.revision, range, tabId: at.tabId } : result;
  }

  /**
   * Refreshes one connected table now (RPC from the data source routes): its
   * records listed by the route, written where the table is (or at `write.at`
   * for a new one).
   */
  async writeDataTable(sheet: RoomMeta, write: DataTableWrite, userId: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
    const room = await this.roomFor(sheet);
    const op = dataTableOp(room.engine, write);
    if (typeof op === 'string') return { ok: false, error: op };
    return this.commit(room, op, userId);
  }

  /** Takes a connected table's block out of the workbook, leaving its values (RPC when a data source is removed). */
  async dropDataTable(sheet: RoomMeta, id: string, userId: string): Promise<void> {
    const room = await this.roomFor(sheet);
    const tab = room.engine.workbook.sheets.find((s) => s.dataTables.some((t) => t.id === id));
    if (tab) this.commit(room, { type: 'patchDataTables', sheetId: tab.id, remove: [id] }, userId);
  }

  /** When the sheet's next scheduled refresh is due (epoch ms; null: none). The routes call it after changing data sources. */
  async scheduleRefresh(sheet: RoomMeta, at: number | null): Promise<void> {
    await this.adopt(sheet);
    if (at === null) await this.ctx.storage.delete(REFRESH_AT);
    else await this.ctx.storage.put(REFRESH_AT, at);
    await this.armRefresh();
  }

  /** Checkpoints after edits, and runs connected tables' scheduled refreshes when due. */
  async alarm(): Promise<void> {
    await super.alarm();
    const due = await this.ctx.storage.get<number>(REFRESH_AT);
    if (due !== undefined && due <= Date.now()) await this.refreshDue();
    await this.armRefresh();
  }

  // ---- The workbook ----

  protected createRoom(snapshot: WorkbookSnapshot, revision: number, ops: CommittedOp[], options: collab.RoomOptions<Op, Engine, Presence>): RoomCore {
    return RoomCore.restore(snapshot, revision, ops, options);
  }

  protected emptySnapshot(): WorkbookSnapshot {
    const workbook = new Workbook();
    workbook.sheets.push(new Sheet(FALLBACK_SHEET_ID, 'Sheet1'));
    return workbook.toJSON();
  }

  protected snapshotOf(room: RoomCore): WorkbookSnapshot {
    return room.engine.toSnapshot();
  }

  protected accessRules(): Pick<collab.RoomOptions<Op, Engine, Presence>, 'mayComment'> {
    return { mayComment: (op, peer, engine) => isCommentersOp(op, peer.userId, engine) };
  }

  /** A scheduled refresh may hold the alarm for later: the checkpoint comes first. */
  protected checkpointSetsAlarm(current: number | null, at: number): boolean {
    return current === null || current > at;
  }

  // ---- Storage and the tenant DB ----

  protected async readStored(key: string): Promise<{ revision: number; snapshot: WorkbookSnapshot } | null> {
    const stored = await readSnapshot(this.env.PRIVATE_STORAGE, key);
    return stored && { revision: stored.revision, snapshot: stored.workbook };
  }

  protected writeStored(key: string, revision: number, workbook: WorkbookSnapshot): Promise<number> {
    return writeSnapshot(this.env.PRIVATE_STORAGE, key, { revision, workbook });
  }

  protected versionKeyFor(snapshotKey: string, versionId: string): string {
    return versionKeyFor(snapshotKey, versionId);
  }

  protected async saveAutoVersion(meta: RoomMeta, version: AutoVersion): Promise<void> {
    const db = await this.tenantDb(meta.workspaceId);
    await insertVersion(db, { ...version, sheetId: meta.sheetId, name: null });
  }

  protected async recordCheckpoint(meta: RoomMeta, checkpoint: CheckpointRecord, announce: boolean): Promise<void> {
    const db = await this.tenantDb(meta.workspaceId);
    const sheet = await recordCheckpoint(db, meta.sheetId, checkpoint);
    const editor = checkpoint.userId;
    if (!announce || !sheet || !editor) return;
    await publishEntityEventRaw({
      env: this.env,
      workspaceId: meta.workspaceId,
      userId: editor,
      entityType: 'sheet',
      action: 'updated',
      entityId: sheet.id,
      data: { id: sheet.id, fileId: sheet.fileId, name: sheet.name, revision: checkpoint.revision, updatedById: editor },
      source: 'web',
    });
  }

  // ---- Server writes ----

  /** Commits an op the server made as an edit by `userId`, sending it to everyone in the sheet. */
  private commit(room: RoomCore, op: Op, userId: string): { ok: true; revision: number } | { ok: false; error: string } {
    const result = this.commitServerOp(room, op, SERVER_CLIENT, userId);
    return result.committed ? { ok: true, revision: result.committed.revision } : { ok: false, error: result.refused ?? 'refused' };
  }

  // ---- Connected tables ----

  /** Refreshes every connected table whose scheduled refresh is due. */
  private async refreshDue(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    const db = await this.tenantDb(meta.workspaceId);
    const sheet = await getSheet(db, meta.sheetId);
    if (!sheet) {
      await this.ctx.storage.delete(REFRESH_AT);
      return;
    }
    for (const source of await dueDataSources(db, meta.sheetId, new Date())) {
      try {
        await this.refreshOne(db, meta, source, sheet.file);
      } catch (err) {
        console.error('[sheets-api/room] scheduled refresh failed:', err);
        await recordRefresh(db, source, { at: new Date(), error: 'failed' }).catch(() => null);
      }
    }
    const next = await nextDueAt(db, meta.sheetId);
    if (next) await this.ctx.storage.put(REFRESH_AT, next.getTime());
    else await this.ctx.storage.delete(REFRESH_AT);
  }

  /** Lists one connected table's records and writes them, recording how it went. */
  private async refreshOne(db: TenantDb, meta: RoomMeta, source: DataSourceRecord, file: DriveFileRef): Promise<void> {
    const plan = await buildRefresh(db, source, file);
    let error = plan.ok ? null : plan.error;
    if (plan.ok) {
      const room = this.room ?? (await this.load());
      const op = dataTableOp(room.engine, plan.write);
      error = typeof op === 'string' || !this.commit(room, op, source.createdById).ok ? 'unplaced' : null;
    }
    const row = await recordRefresh(db, source, { at: new Date(), rowCount: plan.ok ? plan.rowCount : 0, error });
    if (!row) return;
    await publishEntityEventRaw({
      env: this.env,
      workspaceId: meta.workspaceId,
      userId: source.createdById,
      entityType: 'sheet_data_source',
      action: 'updated',
      entityId: row.id,
      data: dataSourceEventData(row) as unknown as Record<string, unknown>,
      source: 'system',
    });
  }

  /** Sets the alarm for the next scheduled refresh, unless an earlier one (a checkpoint) is set. */
  private async armRefresh(): Promise<void> {
    const at = await this.ctx.storage.get<number>(REFRESH_AT);
    if (at === undefined) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }
}

/** The workbook as an .xlsx, or one tab as a CSV (null when that tab does not exist). */
export async function exportEngine(engine: Engine, request: ExportRequest): Promise<ExportedFile | null> {
  const locale = request.locale === 'nl' ? NL_LOCALE : EN_LOCALE;
  if (request.format === 'xlsx') return { bytes: await writeXlsx(engine, { locale }), tabName: null };
  const sheets = engine.workbook.sheets;
  const tab = request.tab ? engine.workbook.getSheet(request.tab) : (sheets.find((s) => !s.props.hidden) ?? sheets[0]);
  if (!tab) return null;
  // A byte-order mark, so Excel reads the CSV as UTF-8.
  return { bytes: new TextEncoder().encode(`﻿${writeCsv(engine, tab.id, { locale })}`), tabName: tab.name };
}

/** The tab and range a request names, or why it names none. */
function target(engine: Engine, request: RangeRequest): { tabId: string; tabName: string; range: Range | null } | string {
  const sheets = engine.workbook.sheets;
  const tab = request.tab
    ? (engine.workbook.getSheet(request.tab) ?? engine.workbook.getSheetByName(request.tab))
    : (sheets.find((s) => !s.props.hidden) ?? sheets[0]);
  if (!tab) return `There is no tab "${request.tab}"`;
  if (!request.range) return { tabId: tab.id, tabName: tab.name, range: null };
  const at = resolveRef(engine, request.range, tab.id);
  if (!at) return `"${request.range}" is not a range like A1:C10`;
  const sheet = engine.workbook.getSheet(at.sheetId)!;
  return { tabId: sheet.id, tabName: sheet.name, range: at.range };
}
