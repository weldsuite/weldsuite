import { DocModel, applyOp, fromHtml, fromMarkdown, insertFragment, caretAt, BODY, type DocSnapshot, type Fragment } from '@weldsuite/docs-engine';
import { textFragment } from '../editor/model/clipboard';

export interface DocMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** The caller may rename, delete and edit it. */
  canEdit: boolean;
}

/** Where the list of documents comes from (the browser for now; docs-api with live co-editing). */
export interface DocDirectory {
  list(): Promise<DocMeta[]>;
  create(name: string, snapshot?: DocSnapshot): Promise<DocMeta>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const META = 'meta';
const SNAPSHOTS = 'snapshots';

/** IndexedDB, one database per workspace: documents with their content. */
export class LocalDocStore implements DocDirectory {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly workspaceId: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(`welddocs:${this.workspaceId}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(META, { keyPath: 'id' });
        req.result.createObjectStore(SNAPSHOTS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    });
    return this.db;
  }

  async list(): Promise<DocMeta[]> {
    const db = await this.open();
    const all = await new Promise<DocMeta[]>((resolve, reject) => {
      const tx = db.transaction([META], 'readonly');
      const req = tx.objectStore(META).getAll() as IDBRequest<DocMeta[]>;
      tx.oncomplete = () => resolve(req.result);
      rejectOnFailure(tx, reject);
    });
    return all.map((meta) => ({ ...meta, canEdit: true })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(name: string, snapshot?: DocSnapshot): Promise<DocMeta> {
    const now = Date.now();
    const meta: DocMeta = { id: newId(), name, createdAt: now, updatedAt: now, canEdit: true };
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

  async load(id: string): Promise<{ meta: DocMeta; snapshot: DocSnapshot | null } | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readonly');
      const metaReq = tx.objectStore(META).get(id) as IDBRequest<DocMeta | undefined>;
      const snapReq = tx.objectStore(SNAPSHOTS).get(id) as IDBRequest<DocSnapshot | undefined>;
      tx.oncomplete = () => resolve(metaReq.result ? { meta: { ...metaReq.result, canEdit: true }, snapshot: snapReq.result ?? null } : null);
      rejectOnFailure(tx, reject);
    });
  }

  async save(id: string, snapshot: DocSnapshot): Promise<void> {
    await this.update(id, (meta) => ({ ...meta, updatedAt: Date.now() }), snapshot);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.update(id, (meta) => ({ ...meta, name, updatedAt: Date.now() }));
  }

  private async update(id: string, change: (meta: DocMeta) => DocMeta, snapshot?: DocSnapshot): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META, SNAPSHOTS], 'readwrite');
      const metas = tx.objectStore(META);
      const get = metas.get(id) as IDBRequest<DocMeta | undefined>;
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

/** A document made from the text of a Markdown, HTML or plain-text file. */
export function documentFromText(name: string, text: string): DocSnapshot {
  const lower = name.toLowerCase();
  let fragment: Fragment;
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) fragment = fromMarkdown(text);
  else if (lower.endsWith('.html') || lower.endsWith('.htm')) fragment = fromHtml(text);
  else fragment = textFragment(text);
  const doc = DocModel.create();
  applyOp(doc, insertFragment(doc, caretAt(BODY, 0), fragment).op);
  // The empty paragraph a new document starts with stays at the end; drop it when the file ended in one.
  const body = doc.body;
  if (body.length >= 2 && body.text(body.length - 2) === '\n\n') applyOp(doc, { type: 'delete', story: BODY, from: body.length - 2, to: body.length - 1 });
  return doc.toSnapshot();
}

/** Rejects when the transaction fails: an error event, or an abort (a failed commit, quota exceeded). */
function rejectOnFailure(tx: IDBTransaction, reject: (reason: Error) => void): void {
  tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
}

function newId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}
