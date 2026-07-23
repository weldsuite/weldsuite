import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Env } from '../lib/protocol';

/**
 * DocumentRoom Durable Object — Yjs collaboration server.
 *
 * One instance per document. Speaks the standard y-websocket wire protocol
 * (binary sync + awareness messages), so the client can use the off-the-shelf
 * `y-websocket` `WebsocketProvider`. The authoritative document is a `Y.Doc`
 * held in memory and persisted to durable DO storage (so it survives
 * hibernation + eviction). The readable JSON snapshot (`docs.content`) is kept
 * fresh separately by the client's debounced autosave — this DO only owns the
 * realtime CRDT layer.
 *
 * Uses the WebSocket Hibernation API. Because the DO can be evicted between
 * messages, `ensureLoaded()` lazily rebuilds the `Y.Doc` + `Awareness` (and
 * their observers) from storage at the start of every handler. Per-connection
 * awareness ids are tracked via `serializeAttachment` so they also survive
 * hibernation and can be cleaned up on close.
 */

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

const STORAGE_KEY = 'ydoc:state';
const PERSIST_DEBOUNCE_MS = 2000;

interface WsAttachment {
  controlled: number[];
}

export class DocumentRoom extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade();
    }
    return new Response('Not found', { status: 404 });
  }

  // ---- Lifecycle / lazy load (hibernation-safe) ----

  private async ensureLoaded(): Promise<void> {
    if (this.loaded && this.doc && this.awareness) return;

    const doc = new Y.Doc();
    const stored = await this.ctx.storage.get<Uint8Array>(STORAGE_KEY);
    if (stored && stored.byteLength > 0) {
      Y.applyUpdate(doc, stored);
    }

    const awareness = new awarenessProtocol.Awareness(doc);
    // The server holds no awareness state of its own.
    awareness.setLocalState(null);

    // Broadcast document updates to every connection except the originator,
    // and schedule a debounced persist.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin instanceof WebSocket ? origin : null);
      this.schedulePersist();
    });

    // Relay awareness changes to all connections and track which client ids
    // each connection controls (for cleanup on disconnect).
    awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin instanceof WebSocket) {
          const ids = new Set(this.getAttachment(origin).controlled);
          added.forEach((id) => ids.add(id));
          removed.forEach((id) => ids.delete(id));
          origin.serializeAttachment({ controlled: Array.from(ids) } satisfies WsAttachment);
        }
        const changed = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(encoder), null);
      },
    );

    this.doc = doc;
    this.awareness = awareness;
    this.loaded = true;
  }

  private handleWebSocketUpgrade(): Promise<Response> {
    return this.ensureLoaded().then(() => {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ controlled: [] } satisfies WsAttachment);

      // Server-initiated sync: send our sync step 1 so the client replies with
      // its state (step 2), and answer the client's own step 1 in turn.
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, messageSync);
      syncProtocol.writeSyncStep1(syncEncoder, this.doc!);
      server.send(encoding.toUint8Array(syncEncoder));

      // Send the current awareness states to the new client.
      const states = this.awareness!.getStates();
      if (states.size > 0) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, messageAwareness);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness!, Array.from(states.keys())),
        );
        server.send(encoding.toUint8Array(awarenessEncoder));
      }

      return new Response(null, { status: 101, webSocket: client });
    });
  }

  // ---- WebSocket Hibernation handlers ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') return; // protocol is binary
    await this.ensureLoaded();

    const data = new Uint8Array(message);
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        // readSyncMessage applies incoming updates with `ws` as the transaction
        // origin, so the doc 'update' observer can skip echoing to the sender.
        syncProtocol.readSyncMessage(decoder, encoder, this.doc!, ws);
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness!,
          decoding.readVarUint8Array(decoder),
          ws,
        );
        break;
      }
      case messageQueryAwareness: {
        const states = this.awareness!.getStates();
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness!, Array.from(states.keys())),
        );
        ws.send(encoding.toUint8Array(encoder));
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ensureLoaded();
    const controlled = this.getAttachment(ws).controlled;
    if (controlled.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness!, controlled, null);
    }
    // Flush the latest doc state to durable storage on disconnect.
    await this.persistNow();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      await this.webSocketClose(ws);
    } catch {
      /* noop */
    }
  }

  // ---- Internal ----

  private getAttachment(ws: WebSocket): WsAttachment {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    return att && Array.isArray(att.controlled) ? att : { controlled: [] };
  }

  private broadcast(message: Uint8Array, exclude: WebSocket | null): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(message);
      } catch {
        /* closed */
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistNow(): Promise<void> {
    if (!this.doc) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const state = Y.encodeStateAsUpdate(this.doc);
    await this.ctx.storage.put(STORAGE_KEY, state);
  }
}
