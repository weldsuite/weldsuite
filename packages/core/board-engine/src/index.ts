/**
 * @weldsuite/board-engine: the WeldBoard whiteboard engine.
 *
 * Pure TypeScript, no DOM, no dependencies besides our own collab core and
 * docs-engine (text measurement and line breaking), so the same code runs in
 * the browser, in the BoardRoom Durable Object and in any worker that reads
 * or writes boards. See docs/plans/weldboard.md.
 */

export * from './model/types';
export { Board } from './model/board';
export { compareOrder, isOrderKey, keyBetween, keysBetween } from './model/order';
export * from './model/text';
export * from './model/schema';
export * from './model/defaults';

export { applyOp } from './ops/apply';
export { transform, runsLength } from './ops/transform';
export { NOOP, batch, isNoop, normalize, touchedIds, unbatch } from './ops/types';
export type { MarksRun, Op, OpOf, OpType, SimpleOp } from './ops/types';
export { isWellFormedOp } from './ops/shape';
export { validateOp } from './ops/validate';

export { boardAdapter, createBoardClient, createBoardRoom, restoreBoardRoom } from './collab/adapter';
export type {
  BoardAdapter,
  BoardClient,
  BoardClientMessage,
  BoardClientOptions,
  BoardCommittedOp,
  BoardPeer,
  BoardPresence,
  BoardRoomCore,
  BoardRoomOptions,
  BoardServerMessage,
} from './collab/adapter';
export { FrameAssembler, MAX_FRAME, decodeClient, decodeServer, encode, refusedBatchId, toFrames } from '@weldsuite/collab';

export * from './geometry/path';
export * from './geometry/shapes';
export * from './geometry/connectors';
export * from './geometry/bounds';
export { SpatialIndex } from './geometry/spatial';
export * from './geometry/snap';
export * from './geometry/arrange';
export * from './geometry/mindmap';

export * from './text/layout';

export * from './display/display';
export * from './display/svg';

export * from './serialize/snapshot';
export * from './serialize/fragment';
export * from './serialize/text';
export * from './serialize/import';
export * from './serialize/import-file';

export * from './legacy/weldflow';
export * from './templates/index';
export * from './display/pdf';
