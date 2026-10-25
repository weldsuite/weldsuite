/**
 * The co-editing protocol between a browser and a sheet's room (the SheetRoom
 * Durable Object): @weldsuite/collab's protocol, with its types filled in for
 * workbooks. See that package for how it works.
 */

import * as collab from '@weldsuite/collab';
import type { WorkbookSnapshot } from '../model/workbook';
import type { Op } from '../ops/types';
import { sheetsAdapter, type Presence } from './adapter';

export type { Presence } from './adapter';
export type { RejectReason } from '@weldsuite/collab';
export { FrameAssembler, MAX_FRAME, encode, refusedBatchId, toFrames } from '@weldsuite/collab';

export type Peer = collab.Peer<Presence>;
export type CommittedOp = collab.CommittedOp<Op>;
export type ClientMessage = collab.ClientMessage<Op, Presence>;
export type ServerMessage = collab.ServerMessage<Op, WorkbookSnapshot, Presence>;

/** Shape checks only: engine options do not matter here. */
const checks = sheetsAdapter();

/**
 * A client message parsed from the socket, or null when it is not one. The
 * room trusts nothing a browser sends: every field is checked, ops all the
 * way down (`isWellFormedOp`), so applying one cannot throw halfway.
 */
export function decodeClient(data: string): ClientMessage | null {
  return collab.decodeClient(data, checks);
}

export function decodeServer(data: string): ServerMessage | null {
  return collab.decodeServer<Op, WorkbookSnapshot, Presence>(data);
}
