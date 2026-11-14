/**
 * The engine work the board routes do in process, as functions the Rust
 * backend calls (rust/docs/collab-rooms.md): on Kubernetes the collab-rooms
 * service serves them as the `BOARD_ENGINE` binding, and in conformance mode
 * the tests hand the same functions to the harness. Each one is what the
 * route it names computes, step for step; the routes themselves keep calling
 * the engine directly.
 *
 * A board travels as the JSON text the room hands over (`snapshot().json`)
 * and a new board's content comes back as the gzipped checkpoint
 * `writeSnapshot` (room/snapshot.ts) stores, so Rust never parses a board.
 */

import {
  Board,
  boardDisplay,
  boardOutline,
  boardToPlainText,
  convertLegacyWhiteboard,
  copySnapshot,
  displayToSvg,
  editOps,
  emptySnapshot,
  isNoop,
  isWellFormedSnapshot,
  legacyWriteOps,
  newId,
  placeSpec,
  selectionBounds,
  snapshotFromImport,
  toLegacyElements,
  type BoardElement,
  type BoardSnapshot,
  type BoardSpec,
  type ElementChange,
  type Op,
} from '@weldsuite/board-engine';
import { CachedMeasurer, MetricsMeasurer } from '@weldsuite/docs-engine';
import { generateId } from '@weldsuite/worker-kit/id';
import type { BoardAiInput } from '@weldsuite/app-api-client/schemas/boards';
import { BoardAiError, boardAiAsk, boardAiPlan, checkBoardAi, type BoardAiAsk } from './services/ai-plan';

type Checkpoint = { ok: true; checkpoint: Uint8Array };
type Refused = { ok: false };

/** The bytes `writeSnapshot` puts in R2 for a new board at revision 0. */
export async function gzipCheckpoint(board: BoardSnapshot): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify({ revision: 0, board })]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * `POST /api/boards`' starting content: empty, or the client's snapshot
 * checked and made canonical (`clientSnapshot`). The snapshot comes as the
 * JSON text the client sent, so it parses with the same key order as the
 * route's body.
 */
async function newBoard(sentJson?: string | null): Promise<Checkpoint | Refused> {
  if (sentJson === undefined || sentJson === null) return { ok: true, checkpoint: await gzipCheckpoint(emptySnapshot()) };
  const sent = JSON.parse(sentJson) as unknown;
  if (!isWellFormedSnapshot(sent)) return { ok: false };
  return { ok: true, checkpoint: await gzipCheckpoint(Board.fromSnapshot(sent).toSnapshot()) };
}

/** A copy of another board's live content (`copyOf`): its comment pins and session state stay behind. */
async function copyBoard(liveJson: string): Promise<Checkpoint> {
  return { ok: true, checkpoint: await gzipCheckpoint(copySnapshot(JSON.parse(liveJson) as BoardSnapshot)) };
}

/** `POST /api/boards/import`: a file's content as a board, and how many of its items could not be read. */
async function importBoard(format: Parameters<typeof snapshotFromImport>[0], content: string): Promise<(Checkpoint & { skipped: number }) | Refused> {
  const read = snapshotFromImport(format, content, () => generateId('el'));
  if (!read) return { ok: false };
  return { ok: true, checkpoint: await gzipCheckpoint(read.snapshot), skipped: read.skipped };
}

/** An old WeldFlow whiteboard's `elements` column (its JSON text, or null) as elements (`legacyElements`). */
function legacyElementsOf(elementsJson: string | null | undefined): unknown[] {
  if (elementsJson === undefined || elementsJson === null) return [];
  const parsed = JSON.parse(elementsJson) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

/** `convertInPlace`'s checkpoint: an old WeldFlow whiteboard's elements as a board. */
async function convertLegacy(elementsJson: string | null, lastEditedBy: string | null): Promise<Checkpoint> {
  const snapshot = convertLegacyWhiteboard(legacyElementsOf(elementsJson), lastEditedBy ? { createdBy: lastEditedBy } : {});
  return { ok: true, checkpoint: await gzipCheckpoint(snapshot) };
}

/** The first line of an element's text as a task title, the rest as its description (`taskFields`). */
export function taskFields(el: BoardElement): { title: string; description?: string } | null {
  const text = (el.text?.text ?? el.title ?? '').trim();
  if (!text) return null;
  const [first, ...rest] = text.split('\n');
  const description = rest.join('\n').trim();
  return { title: first!.trim().slice(0, 500) || text.slice(0, 500), ...(description ? { description: description.slice(0, 10_000) } : {}) };
}

export const TASKABLE = new Set<BoardElement['type']>(['sticky', 'card', 'shape', 'text']);

/** `POST /api/boards/:id/tasks`: the elements that become tasks, each with its task's fields, in order. */
function taskPlan(liveJson: string, elementIds: string[]): { elementId: string; title: string; description?: string }[] {
  const content = Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot);
  return [...new Set(elementIds)]
    .map((id) => content.get(id))
    .filter((el): el is BoardElement => !!el && TASKABLE.has(el.type) && !el.locked && taskFields(el) !== null)
    .map((el) => ({ elementId: el.id, ...taskFields(el)! }));
}

/** The task cards that take the made tasks' elements' places, as one batch. */
function taskCards(liveJson: string, created: { elementId: string; taskId: string }[], userId: string, now: number): { op: Op } {
  const content = Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot);
  const ops: Op[] = [];
  for (const { elementId, taskId } of created) {
    const el = content.get(elementId);
    if (!el) continue;
    const card: BoardElement = {
      id: newId(),
      type: 'record',
      order: el.order,
      ...(el.parent ? { parent: el.parent } : {}),
      x: el.x,
      y: el.y,
      w: Math.max(240, Math.min(el.w, 400)),
      h: 96,
      record: { kind: 'task', id: taskId },
      createdBy: userId,
      createdAt: now,
    };
    ops.push({ type: 'create', elements: [card] }, { type: 'delete', ids: [el.id] });
  }
  return { op: { type: 'batch', ops } };
}

/** Most elements the render draws: past this a phone shows the first ones, and says so. */
const RENDER_ELEMENTS = 5000;
const renderMeasurer = new CachedMeasurer(new MetricsMeasurer(), 50_000);

/** `GET /api/boards/:id/render`: the live board as one SVG. */
function render(liveJson: string, width: number): { svg: string; elements: number; drawn: number } {
  const board = Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot);
  const paint = board.paintOrder();
  const only = new Set(paint.slice(0, RENDER_ELEMENTS).map((e) => e.id));
  const view = selectionBounds(board, only) ?? { x: 0, y: 0, w: 800, h: 600 };
  const svg = displayToSvg(boardDisplay(board, { measurer: renderMeasurer }, only), { view, width, padding: 48, background: '#ffffff' });
  return { svg, elements: paint.length, drawn: only.size };
}

// ---- The deprecated `/v1/whiteboards` façade (BoardsInternal's WeldFlow format) ----

/** A live board as WeldFlow elements (`toLegacyElements`). */
function legacyElements(liveJson: string): unknown[] {
  return toLegacyElements(Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot));
}

/** What a write of WeldFlow elements changes on a live board, as ops; null when nothing. */
function legacyWrite(liveJson: string, elements: unknown[]): { op: Op | null } {
  const op = legacyWriteOps(Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot), elements);
  return { op: isNoop(op) ? null : op };
}

/** A new board from WeldFlow elements (`/create` with `elements`): its checkpoint, and the elements as the board now reads them. */
async function boardFromLegacy(elements: unknown[], createdBy: string): Promise<Checkpoint & { elements: unknown[] }> {
  const snapshot = convertLegacyWhiteboard(elements, { createdBy });
  return { ok: true, checkpoint: await gzipCheckpoint(snapshot), elements: toLegacyElements(Board.fromSnapshot(snapshot)) };
}

/** A board read as `outline`, `text` or `snapshot` (`readAs`), from the live board or an old whiteboard's elements. */
function readAs(source: { liveJson: string } | { legacyJson: string | null }, format: 'outline' | 'text' | 'snapshot', limit?: number | null): Record<string, unknown> {
  const board =
    'liveJson' in source
      ? Board.fromSnapshot(JSON.parse(source.liveJson) as BoardSnapshot)
      : Board.fromSnapshot(convertLegacyWhiteboard(legacyElementsOf(source.legacyJson)));
  if (format === 'outline') return { elements: boardOutline(board, limit ?? 500), count: board.size };
  if (format === 'text') return { text: boardToPlainText(board) };
  return { snapshot: board.toSnapshot() };
}

/** A board spec laid out on the live board (`/add`). */
function place(liveJson: string, spec: BoardSpec, createdBy: string, now: number, at?: { x: number; y: number } | null) {
  const placed = placeSpec(Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot), spec, { createdBy, now, ...(at ? { at } : {}) });
  return { op: placed.op, ids: placed.ids, all: placed.all, keys: placed.keys };
}

/** A `BoardAiError` as the route answers it. */
interface AiRefusal {
  code: BoardAiError['code'];
  message: string;
  status: BoardAiError['status'];
}

function refusalOf(err: unknown): AiRefusal {
  if (!(err instanceof BoardAiError)) throw err;
  return { code: err.code, message: err.message, status: err.status };
}

/**
 * `POST /api/boards/:id/ai` before the model (`runBoardAi`): a refusal
 * before the AI layer is reached (`refused`: no prompt, no notes), one after
 * it (`refusedAfterAi`: too few notes, nothing to summarise), or what to ask
 * the model (`ask`). The caller checks AI and the wallet between the two.
 */
function aiPrepare(liveJson: string, input: BoardAiInput): { refused: AiRefusal } | { refusedAfterAi: AiRefusal } | { ask: BoardAiAsk } {
  const board = Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot);
  try {
    checkBoardAi(board, input);
  } catch (err) {
    return { refused: refusalOf(err) };
  }
  try {
    return { ask: boardAiAsk(board, input) };
  } catch (err) {
    return { refusedAfterAi: refusalOf(err) };
  }
}

/**
 * `POST /api/boards/:id/ai` after the model: the ops to commit (null for
 * none) and what the route answers, or the refusal (nothing to place).
 */
function aiPlan(
  liveJson: string,
  input: BoardAiInput,
  answer: unknown,
  userId: string,
  now: number,
): { op: Op | null; elementIds: string[]; text?: string; title?: string } | { refused: AiRefusal } {
  const board = Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot);
  try {
    const plan = boardAiPlan(board, input, answer, { userId, now });
    return { op: isNoop(plan.op) ? null : plan.op, elementIds: plan.elementIds, ...(plan.text !== undefined ? { text: plan.text, title: plan.title } : {}) };
  } catch (err) {
    return { refused: refusalOf(err) };
  }
}

/** Elements changed or removed by id (`/edit`). */
function edit(liveJson: string, changes: ElementChange[]): { op: Op | null; changed: string[]; skipped: string[] } {
  const { op, changed, skipped } = editOps(Board.fromSnapshot(JSON.parse(liveJson) as BoardSnapshot), changes);
  return { op: isNoop(op) ? null : op, changed, skipped };
}

export const boardEngine = {
  newBoard,
  copyBoard,
  importBoard,
  convertLegacy,
  taskPlan,
  taskCards,
  render,
  legacyElements,
  legacyWrite,
  boardFromLegacy,
  readAs,
  place,
  edit,
  aiPrepare,
  aiPlan,
};

/** `boardEngine` shaped as a namespace binding (`ns.get(ns.idFromName(name))[method]`). */
export function boardEngineNamespace() {
  return { idFromName: (name: string) => ({ name }), get: () => boardEngine };
}
