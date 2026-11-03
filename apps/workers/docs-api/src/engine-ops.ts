/**
 * The engine work the document routes do in process, as functions the Rust
 * backend calls (rust/docs/collab-rooms.md): on Kubernetes the collab-rooms
 * service serves them as the `DOC_ENGINE` binding, and in conformance mode
 * the tests hand the same functions to the harness. Each one is what the
 * route it names computes, step for step; the routes themselves keep
 * calling the engine directly.
 */

import { DocModel, isWellFormedSnapshot, type DocSnapshot } from '@weldsuite/docs-engine';
import { DOC_SNAPSHOT_MAX_BYTES } from '@weldsuite/app-api-client/schemas/docs';

export type NewDocument =
  | { ok: true; revision: 0; checkpoint: Uint8Array }
  | { ok: false; reason: 'too_large' | 'invalid_snapshot' };

/**
 * `POST /api/docs`'s starting snapshot (`startingSnapshot`), as the gzipped
 * checkpoint `writeSnapshot` stores. The snapshot comes as the JSON text the
 * client sent, so it parses with the same key order as the route's body.
 */
async function newDocument(sentJson?: string): Promise<NewDocument> {
  const sent = sentJson === undefined ? undefined : (JSON.parse(sentJson) as unknown);
  let doc: DocSnapshot;
  if (sent === undefined) {
    doc = DocModel.create().toSnapshot();
  } else {
    if (JSON.stringify(sent).length > DOC_SNAPSHOT_MAX_BYTES) return { ok: false, reason: 'too_large' };
    if (!isWellFormedSnapshot(sent)) return { ok: false, reason: 'invalid_snapshot' };
    try {
      doc = DocModel.fromSnapshot(sent).toSnapshot();
    } catch {
      return { ok: false, reason: 'invalid_snapshot' };
    }
  }
  return { ok: true, revision: 0, checkpoint: await gzipJson({ revision: 0, doc }) };
}

/** The bytes `writeSnapshot` (room/snapshot.ts) puts in R2 for this value. */
export async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const docEngine = { newDocument };

/** `docEngine` shaped as a namespace binding (`ns.get(ns.idFromName(name))[method]`). */
export function docEngineNamespace() {
  return { idFromName: (name: string) => ({ name }), get: () => docEngine };
}
