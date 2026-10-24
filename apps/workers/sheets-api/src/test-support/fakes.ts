/**
 * In-memory stand-ins for the Workers bindings sheets-api uses (R2, Durable
 * Object storage and sockets), for tests that run under node.
 */

import { FrameAssembler, decodeServer, type ServerMessage } from '@weldsuite/sheets-engine';
import type { Admission, ExportRequest, ExportedFile, RoomMeta } from '../room/sheet-room';

export class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, body: ArrayBuffer | Uint8Array | string): Promise<void> {
    this.objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body));
  }

  async get(key: string): Promise<{ body: ReadableStream; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const bytes = this.objects.get(key);
    return bytes ? { body: new Blob([bytes]).stream(), arrayBuffer: async () => new Uint8Array(bytes).buffer } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  asBinding(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** Durable Object storage's key-value API, with values copied in and out like the real one. */
export class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }

  async delete(keys: string | string[]): Promise<number> {
    let count = 0;
    for (const k of Array.isArray(keys) ? keys : [keys]) if (this.data.delete(k)) count++;
    return count;
  }

  async list<T>(options: { prefix?: string; end?: string } = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix ?? '') && (options.end === undefined || k < options.end))
      .sort((a, b) => (a < b ? -1 : 1));
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async sync(): Promise<void> {}
}

export class FakeSocket {
  readonly frames: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;

  send(frame: string): void {
    this.frames.push(frame);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Everything received so far, frames joined back into messages. */
  messages(): ServerMessage[] {
    const assembler = new FrameAssembler();
    return this.frames
      .map((f) => assembler.accept(f))
      .filter((text): text is string => text !== null)
      .map((text) => decodeServer(text)!);
  }

  asSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** A Durable Object's `ctx`: storage plus the hibernatable sockets it holds. */
export function fakeObjectState(id = 'a'.repeat(64)) {
  const storage = new FakeStorage();
  const sockets: FakeSocket[] = [];
  const ctx = {
    id: { toString: () => id },
    storage,
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    getWebSockets: () => [...sockets],
  } as unknown as DurableObjectState;
  return { ctx, storage, sockets };
}

/**
 * SHEET_ROOM for route tests: records admissions and hands out a fixed
 * ticket; an export is the format's name as bytes (tab "missing" has none).
 */
export function fakeRoomNamespace() {
  const admissions: { name: string; admission: Admission }[] = [];
  const exports: { name: string; sheet: RoomMeta; request: ExportRequest }[] = [];
  const binding = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      admit: async (admission: Admission) => {
        admissions.push({ name: id.name, admission });
        return `${'f'.repeat(64)}.ticket-for-${admission.userId}`;
      },
      exportFile: async (sheet: RoomMeta, request: ExportRequest): Promise<ExportedFile | null> => {
        exports.push({ name: id.name, sheet, request });
        if (request.tab === 'missing') return null;
        const tabName = request.format === 'csv' ? (request.tab ?? 'Sheet1') : null;
        return { bytes: new TextEncoder().encode(`${request.format} file`), tabName };
      },
    }),
  };
  return { admissions, exports, binding: binding as unknown as DurableObjectNamespace<import('../room/sheet-room').SheetRoom> };
}
