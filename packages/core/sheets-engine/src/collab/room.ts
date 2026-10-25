/**
 * The server half of co-editing for one open spreadsheet, wrapped by the
 * SheetRoom Durable Object (which owns sockets, persistence and auth) and by
 * tests. The protocol logic is @weldsuite/collab's `RoomCore`; this class
 * runs it on a sheets engine and keeps the constructor the worker uses.
 */

import * as collab from '@weldsuite/collab';
import type { Engine, EngineOptions } from '../calc/engine';
import type { WorkbookSnapshot } from '../model/workbook';
import type { Op } from '../ops/types';
import { sheetsAdapter, type Presence } from './adapter';
import type { CommittedOp } from './protocol';

/** A message for one client, or (to: null) for every client except `except`. */
export type Outgoing = collab.Outgoing<Op, WorkbookSnapshot, Presence>;

export interface RoomOptions extends collab.RoomOptions<Op> {
  engine?: EngineOptions;
}

type GenericRoom = collab.RoomCore<Engine, Op, WorkbookSnapshot, Presence>;

/**
 * The generic class with its constructor alone: its static `restore` takes an
 * adapter, and this class has a `restore` of its own with the sheet signature.
 */
const GenericRoom: new (
  adapter: collab.OtAdapter<Engine, Op, WorkbookSnapshot, Presence>,
  snapshot: WorkbookSnapshot,
  revision: number,
  options?: collab.RoomOptions<Op>,
) => GenericRoom = collab.RoomCore;

export class RoomCore extends GenericRoom {
  constructor(snapshot: WorkbookSnapshot, revision: number, options: RoomOptions = {}) {
    super(sheetsAdapter(options.engine), snapshot, revision, options);
  }

  /** The workbook as committed so far. */
  get engine(): Engine {
    return this.state;
  }

  /**
   * A room rebuilt after a Durable Object restart: the snapshot at
   * `snapshotRevision`, then `ops` in revision order. Ops at or before the
   * snapshot are not applied again but go back into the log, so clients a
   * little behind still catch up without a full reload.
   */
  static restore(snapshot: WorkbookSnapshot, snapshotRevision: number, ops: CommittedOp[], options: RoomOptions = {}): RoomCore {
    const room = new RoomCore(snapshot, snapshotRevision, options);
    room.replay(ops);
    return room;
  }
}
