import type { WorkbookSnapshot } from '@weldsuite/sheets-engine';

export interface SheetMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Where spreadsheets are kept. Phase 2 stores them in the browser
 * (`LocalSheetStore`); phase 3 swaps in the sheets-api client, after which a
 * sheet is a WeldDrive file opened through its SheetRoom.
 */
export interface SheetStore {
  list(): Promise<SheetMeta[]>;
  create(name: string): Promise<SheetMeta>;
  load(id: string): Promise<{ meta: SheetMeta; snapshot: WorkbookSnapshot | null } | null>;
  save(id: string, snapshot: WorkbookSnapshot): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const META = 'meta';
const SNAPSHOTS = 'snapshots';

/** IndexedDB, one database per workspace. */
export class LocalSheetStore implements SheetStore {
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
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
  }

  async list(): Promise<SheetMeta[]> {
    const all = (await this.run<SheetMeta[]>([META], 'readonly', (tx) => tx.objectStore(META).getAll())) ?? [];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(name: string): Promise<SheetMeta> {
    const now = Date.now();
    const meta: SheetMeta = { id: newId(), name, createdAt: now, updatedAt: now };
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
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
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
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
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
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
  }

  async remove(id: string): Promise<void> {
    await this.run([META, SNAPSHOTS], 'readwrite', (tx) => {
      tx.objectStore(META).delete(id);
      tx.objectStore(SNAPSHOTS).delete(id);
    });
  }
}

function newId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}
