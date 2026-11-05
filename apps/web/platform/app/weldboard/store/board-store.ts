import type { BoardSnapshot } from '@weldsuite/board-engine';

export interface BoardMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The caller may rename, delete and edit it. */
  canEdit: boolean;
  projectId?: string | null;
  templateCategory?: string | null;
  /** An old WeldFlow whiteboard that becomes a board when opened. */
  legacy?: boolean;
  fileId?: string | null;
}

/** Where the list of boards comes from: board-api in a workspace, the browser in the preview. */
export interface BoardDirectory {
  list(options?: { projectId?: string; templates?: boolean; projects?: boolean }): Promise<BoardMeta[]>;
  create(name: string, options?: { snapshot?: BoardSnapshot; projectId?: string; fromBoardId?: string }): Promise<BoardMeta>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const META = 'meta';
const SNAPSHOTS = 'snapshots';

function newLocalId(): string {
  return `brd_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function rejectOnFailure(tx: IDBTransaction, reject: (reason: unknown) => void): void {
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
}

/** IndexedDB, one database per workspace: boards with their content (the signed-out preview). */
export class LocalBoardStore implements BoardDirectory {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly workspaceId: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(`weldboard:${this.workspaceId}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META, { keyPath: 'id' });
        req.result.createObjectStore(SNAPSHOTS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    });
    return this.db;
  }

  async list(): Promise<BoardMeta[]> {
    const db = await this.open();
    const all = await new Promise<BoardMeta[]>((resolve, reject) => {
      const tx = db.transaction([META], 'readonly');
      const req = tx.objectStore(META).getAll() as IDBRequest<BoardMeta[]>;
      tx.oncomplete = () => resolve(req.result);
      rejectOnFailure(tx, reject);
    });
    return all.map((meta) => ({ ...meta, canEdit: true })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(name: string, options: { snapshot?: BoardSnapshot; fromBoardId?: string } = {}): Promise<BoardMeta> {
    const now = Date.now();
    const meta: BoardMeta = { id: newLocalId(), name, createdAt: now, updatedAt: now, canEdit: true };
    let snapshot = options.snapshot;
    if (!snapshot && options.fromBoardId) snapshot = (await this.load(options.fromBoardId))?.snapshot ?? undefined;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readwrite');
      tx.objectStore(META).put(meta);
      if (snapshot) tx.objectStore(SNAPSHOTS).put(snapshot, meta.id);
      tx.oncomplete = () => resolve();
      rejectOnFailure(tx, reject);
    });
    return meta;
  }

  async load(id: string): Promise<{ meta: BoardMeta; snapshot: BoardSnapshot | null } | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readonly');
      const metaReq = tx.objectStore(META).get(id) as IDBRequest<BoardMeta | undefined>;
      const snapReq = tx.objectStore(SNAPSHOTS).get(id) as IDBRequest<BoardSnapshot | undefined>;
      tx.oncomplete = () => resolve(metaReq.result ? { meta: { ...metaReq.result, canEdit: true }, snapshot: snapReq.result ?? null } : null);
      rejectOnFailure(tx, reject);
    });
  }

  async save(id: string, snapshot: BoardSnapshot): Promise<void> {
    await this.update(id, (meta) => ({ ...meta, updatedAt: Date.now() }), snapshot);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.update(id, (meta) => ({ ...meta, name, updatedAt: Date.now() }));
  }

  private async update(id: string, change: (meta: BoardMeta) => BoardMeta, snapshot?: BoardSnapshot): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readwrite');
      const metas = tx.objectStore(META);
      const get = metas.get(id) as IDBRequest<BoardMeta | undefined>;
      get.onsuccess = () => {
        if (get.result) metas.put(change(get.result));
      };
      if (snapshot) tx.objectStore(SNAPSHOTS).put(snapshot, id);
      tx.oncomplete = () => resolve();
      rejectOnFailure(tx, reject);
    });
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readwrite');
      tx.objectStore(META).delete(id);
      tx.objectStore(SNAPSHOTS).delete(id);
      tx.oncomplete = () => resolve();
      rejectOnFailure(tx, reject);
    });
  }
}
