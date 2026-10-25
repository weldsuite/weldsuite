/**
 * @weldsuite/collab: server-sequenced operational-transform co-editing,
 * independent of the kind of document.
 *
 * `RoomCore` (the server half, wrapped by a Durable Object) and `CollabClient`
 * (the browser half) speak the JSON protocol in protocol.ts. Everything about
 * the document itself (applying, transforming and checking ops, snapshots,
 * presence) comes from an `OtAdapter`, so WeldSheets and WeldDocs share one
 * implementation of the protocol. Pure TypeScript with no dependencies.
 */

export type { OtAdapter } from './adapter';
export { RoomCore } from './room';
export type { Outgoing, RoomOptions } from './room';
export { CollabClient } from './client';
export type { CollabClientOptions } from './client';
export { FrameAssembler, MAX_FRAME, decodeClient, decodeServer, encode, refusedBatchId, toFrames } from './protocol';
export type { ClientMessage, CommittedOp, Peer, RejectReason, ServerMessage, ShapeChecks } from './protocol';
