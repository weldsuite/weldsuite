import { readSpreadsheet, type WorkbookSnapshot } from '@weldsuite/sheets-engine';
import type { SheetFileLocale, SheetImportWarning } from '@weldsuite/app-api-client/schemas/sheets';
import { sheetLocale } from '../editor/number-formats';

/** Most cells a file imported into the preview may have (it lives in the browser). */
const LOCAL_MAX_CELLS = 250_000;

export interface SheetMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The caller may rename, delete and edit it. */
  canEdit: boolean;
}

/**
 * Where the list of spreadsheets comes from. In a workspace it is sheets-api
 * (`ApiSheetDirectory`): a sheet is a WeldDrive file, and its content is
 * edited over its room socket. The signed-out preview keeps sheets in the
 * browser (`LocalSheetStore`), content included.
 */
export interface SheetDirectory {
  list(): Promise<SheetMeta[]>;
  /** `firstTabName` names the first tab in the creator's language. */
  create(name: string, firstTabName: string): Promise<SheetMeta>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** A new spreadsheet from an .xlsx, .csv or .tsv file, read in `locale`. */
  importFile(file: File, locale: SheetFileLocale): Promise<ImportedSheet>;
}

export interface ImportedSheet {
  meta: SheetMeta;
  /** What the file had that the spreadsheet does not. */
  warnings: SheetImportWarning[];
}

const META = 'meta';
const SNAPSHOTS = 'snapshots';

/** IndexedDB, one database per workspace: the preview's sheets, content included. */
export class LocalSheetStore implements SheetDirectory {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly workspaceId: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(`weldsheets:${this.workspaceId}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META, { keyPath: 'id' });
        req.result.createObjectStore(SNAPSHOTS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    });
    return this.db;
  }

  private async run<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = fn(tx);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      rejectOnFailure(tx, reject);
    });
  }

  async list(): Promise<SheetMeta[]> {
    const all = (await this.run<SheetMeta[]>([META], 'readonly', (tx) => tx.objectStore(META).getAll())) ?? [];
    return all.map((meta) => ({ ...meta, canEdit: true })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(name: string): Promise<SheetMeta> {
    const now = Date.now();
    const meta: SheetMeta = { id: newId(), name, createdAt: now, updatedAt: now, canEdit: true };
    await this.run([META], 'readwrite', (tx) => {
      tx.objectStore(META).put(meta);
    });
    return meta;
  }

  async load(id: string): Promise<{ meta: SheetMeta; snapshot: WorkbookSnapshot | null } | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readonly');
      const metaReq = tx.objectStore(META).get(id) as IDBRequest<SheetMeta | undefined>;
      const snapReq = tx.objectStore(SNAPSHOTS).get(id) as IDBRequest<WorkbookSnapshot | undefined>;
      tx.oncomplete = () => resolve(metaReq.result ? { meta: metaReq.result, snapshot: snapReq.result ?? null } : null);
      rejectOnFailure(tx, reject);
    });
  }

  async save(id: string, snapshot: WorkbookSnapshot): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readwrite');
      const metas = tx.objectStore(META);
      const get = metas.get(id) as IDBRequest<SheetMeta | undefined>;
      get.onsuccess = () => {
        if (get.result) metas.put({ ...get.result, updatedAt: Date.now() });
      };
      tx.objectStore(SNAPSHOTS).put(snapshot, id);
      tx.oncomplete = () => resolve();
      rejectOnFailure(tx, reject);
    });
  }

  async rename(id: string, name: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META], 'readwrite');
      const metas = tx.objectStore(META);
      const get = metas.get(id) as IDBRequest<SheetMeta | undefined>;
      get.onsuccess = () => {
        if (get.result) metas.put({ ...get.result, name, updatedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      rejectOnFailure(tx, reject);
    });
  }

  async remove(id: string): Promise<void> {
    await this.run([META, SNAPSHOTS], 'readwrite', (tx) => {
      tx.objectStore(META).delete(id);
      tx.objectStore(SNAPSHOTS).delete(id);
    });
  }

  /** Reads the file here in the browser, as sheets-api does for a workspace. */
  async importFile(file: File, locale: SheetFileLocale): Promise<ImportedSheet> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { workbook, warnings } = await readSpreadsheet(file.name, bytes, { locale: sheetLocale(locale).format, maxCells: LOCAL_MAX_CELLS });
    const meta = await this.create(file.name.replace(/\.[^.]+$/, '').trim() || file.name);
    await this.save(meta.id, workbook);
    return { meta, warnings };
  }
}

/**
 * Rejects when the transaction fails: an error event, or an abort, which is
 * all a failed commit (quota exceeded, for one) fires.
 */
function rejectOnFailure(tx: IDBTransaction, reject: (reason: Error) => void): void {
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
}

function newId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}
