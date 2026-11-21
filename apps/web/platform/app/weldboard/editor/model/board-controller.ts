/**
 * The board editor's state and every edit, as SheetController and
 * DocController are for sheets and documents: the board (owned by the
 * collaboration client in a workspace, by this controller in the preview),
 * the spatial index, the camera, the selection, the tool, the text being
 * edited, undo, and what the overlay shows while a gesture is in progress.
 *
 * Every change goes through `apply`, which hands the op to `applyOp` (the
 * room connection, or the local board) and records it for undo.
 */

import {
  Board,
  SpatialIndex,
  applyOp as applyLocally,
  batch,
  connectorGeometry,
  deleteOps,
  elementBounds,
  elementTextLayout,
  fittedTextHeight,
  isNoop,
  keyAllowed,
  normalize,
  selectionBounds,
  unbatch,
  type BoardElement,
  type BoardPeer,
  type BoardPresence,
  type ElementStyle,
  type Guide,
  type Op,
  type Point,
  type Rect,
} from '@weldsuite/board-engine';
import { CachedMeasurer, CanvasMeasurer, type TextMeasurer } from '@weldsuite/docs-engine';
import { fitRect, visibleRect, zoomAt, type Camera } from './camera';
import { History } from './history';
import type { ToolKind, ToolOptions } from './tools';
import { DEFAULT_TOOL_OPTIONS, isDrawingTool } from './tools';

export interface ControllerOptions {
  /** Applies an op and returns its inverse: the room connection in a workspace. Absent: the controller's own board. */
  applyOp?: (op: Op) => Op;
  userId: string;
  userName: string;
  /** Called after each local op (the preview saves the board). */
  onOp?: (op: Op) => void;
  measurer?: TextMeasurer;
}

/** What the overlay draws for a gesture in progress. */
export interface Transient {
  marquee?: Rect | null;
  guides?: Guide[];
  /** A connector being drawn: its path, and the end it would snap to. */
  connector?: { points: Point[]; target: string | null } | null;
  /** A pen stroke being drawn (absolute points). */
  stroke?: { points: Point[]; color: string; width: number; opacity: number } | null;
  /** Elements the eraser is about to take. */
  erasing?: Set<string>;
  /** A shape or frame being drawn. */
  creating?: Rect | null;
  /** The element under the pointer (hover outline, drop target). */
  hover?: string | null;
  dropTarget?: string | null;
}

export interface TextEditing {
  id: string;
  anchor: number;
  head: number;
  /** Column to keep when moving up and down. */
  goalX?: number;
}

/** What a text box's lines depend on: a change to any of them can move its bottom. */
const TEXT_LAYOUT_KEYS = ['text', 'fontSize', 'fontFamily', 'w', 'h'];

let measurerSingleton: CachedMeasurer | null = null;
/** One shared canvas measurer with a width cache in front (cleared when web fonts finish loading). */
function browserMeasurer(): TextMeasurer {
  if (!measurerSingleton) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const ctx = canvas.getContext('2d') as unknown as ConstructorParameters<typeof CanvasMeasurer>[0];
    measurerSingleton = new CachedMeasurer(new CanvasMeasurer(ctx));
  }
  return measurerSingleton;
}

export class BoardController {
  board: Board;
  index: SpatialIndex;
  readonly history = new History();
  readonly measurer: TextMeasurer;
  camera: Camera = { x: -200, y: -120, zoom: 1 };
  viewport = { width: 1, height: 1 };
  selection = new Set<string>();
  tool: ToolKind = 'select';
  toolOptions: ToolOptions = { ...DEFAULT_TOOL_OPTIONS };
  /** Keep the tool after one use (double-click on a tool button). */
  toolLocked = false;
  editing: TextEditing | null = null;
  transient: Transient = {};
  readOnly = false;
  /** May add, move and resolve comment pins while read-only. */
  canComment = false;
  peers: BoardPeer[] = [];
  /** The client id being followed (their viewport drives this one). */
  following: string | null = null;
  presenting = false;
  slide: string | null = null;
  /** The last reaction this person sent, for the presence. */
  reaction: [string, number] | null = null;
  cursor: Point | null = null;
  /** Show who wrote each sticky. */
  showAuthors = false;
  /** The style the style painter holds (copy style), or null. */
  copiedStyle: ElementStyle | null = null;
  showGrid = true;
  /** Names by user id, for authors, assignees and peers. */
  names = new Map<string, string>();
  /** Elements the find bar matched, ringed on the board while it is open. */
  findHits: ReadonlySet<string> = new Set();
  /** The canvas behind a board without a background of its own (dimmer in dark mode). */
  canvasBackground = '#f7f8fa';

  private readonly listeners = new Set<() => void>();
  private readonly renderListeners = new Set<() => void>();
  private notifyQueued = false;
  version = 0;

  constructor(board: Board, readonly options: ControllerOptions) {
    this.board = board;
    this.measurer = options.measurer ?? browserMeasurer();
    this.index = new SpatialIndex(board);
    this.index.rebuild();
  }

  // ---------------------------------------------------------------- subscriptions

  /** React subscribers: toolbars, panels. Batched to one call per frame. Bound, for `useSyncExternalStore`. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = (): number => this.version;

  /** The canvas: told to redraw on any change, without going through React. */
  onRender(fn: () => void): () => void {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  }

  /** Something visible changed: redraw now, tell React on the next frame. */
  changed(react = true): void {
    for (const fn of this.renderListeners) fn();
    if (!react) return;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    const run = () => {
      this.notifyQueued = false;
      this.version++;
      for (const fn of this.listeners) fn();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  // ---------------------------------------------------------------- applying

  /**
   * Applies an op made here and records it for undo. Returns false when nothing happened.
   * `undoable: false` applies it without an undo step: the steps before it move past it, as past
   * a collaborator's op, so undo never takes it back (a round change that took other people's
   * votes away, which the room would not let anyone put back).
   */
  apply(op: Op, options: { gesture?: string; select?: Iterable<string>; comment?: boolean; undoable?: boolean } = {}): boolean {
    if (this.readOnly && !(options.comment && this.canComment)) return false;
    const n = this.fitNewText(normalize(op));
    if (isNoop(n)) return false;
    const before = [...this.selection];
    const { op: done, inverse } = this.runFitted(n);
    if (options.select) this.selection = new Set(options.select);
    this.pruneSelection();
    if (options.undoable === false) this.history.remote(done);
    else this.history.record(done, inverse, { gesture: options.gesture, before, after: [...this.selection] });
    this.options.onOp?.(done);
    this.changed();
    return true;
  }

  /**
   * Runs a local op, and with it whatever keeps text boxes as tall as their
   * text: a line typed, deleted, made bold or bigger, or a box made narrower
   * moves the box's bottom in the same step (one undo, one op for the others).
   */
  private runFitted(op: Op): { op: Op; inverse: Op } {
    const inverse = this.run(op);
    const fit = this.textHeightOps(op);
    if (!fit.length) return { op, inverse };
    const fitOp = batch(fit);
    const fitInverse = this.run(fitOp);
    return { op: batch([op, fitOp]), inverse: batch([fitInverse, inverse]) };
  }

  /** New text boxes, as tall as their text from the start (in the create itself). */
  private fitNewText(op: Op): Op {
    const ops = unbatch(op);
    if (!ops.some((o) => o.type === 'create' && o.elements.some((e) => e.type === 'text'))) return op;
    const options = { measurer: this.measurer, showAuthors: this.showAuthors };
    const fit = (el: BoardElement): BoardElement => {
      const h = fittedTextHeight(el, options);
      return h === null || Math.abs(h - el.h) < 0.5 ? el : { ...el, h };
    };
    return batch(ops.map((o) => (o.type === 'create' ? { ...o, elements: o.elements.map(fit) } : o)));
  }

  /** The ops that fit each text box `op` changed to its text, where its height no longer does. */
  private textHeightOps(op: Op): Op[] {
    const ids = new Set<string>();
    for (const o of unbatch(op)) {
      const textOp = o.type === 'insertText' || o.type === 'deleteText' || o.type === 'formatText';
      if (textOp || (o.type === 'set' && TEXT_LAYOUT_KEYS.some((k) => k in o.patch))) ids.add(o.id);
    }
    const out: Op[] = [];
    for (const id of ids) {
      const el = this.board.get(id);
      const h = el ? fittedTextHeight(el, { measurer: this.measurer, showAuthors: this.showAuthors }) : null;
      if (el && h !== null && Math.abs(h - el.h) >= 0.5) out.push({ type: 'set', id, patch: { h } });
    }
    return out;
  }

  private run(op: Op): Op {
    const inverse = this.options.applyOp ? this.options.applyOp(op) : applyLocally(this.board, op);
    this.index.sync(this.board.takeDirty());
    return inverse;
  }

  undo(): void {
    if (this.readOnly) return;
    const entry = this.history.undoStack.pop();
    if (!entry) return;
    const inverse = this.run(entry.inverse);
    this.history.redoStack.push({ ...entry, op: entry.inverse, inverse, gesture: undefined });
    this.options.onOp?.(entry.inverse);
    this.selection = new Set(entry.before);
    this.editing = null;
    this.pruneSelection();
    this.changed();
  }

  redo(): void {
    if (this.readOnly) return;
    const entry = this.history.redoStack.pop();
    if (!entry) return;
    const inverse = this.run(entry.inverse);
    this.history.undoStack.push({ ...entry, op: entry.inverse, inverse, gesture: undefined });
    this.options.onOp?.(entry.inverse);
    this.selection = new Set(entry.after);
    this.editing = null;
    this.pruneSelection();
    this.changed();
  }

  /** Someone else's op, applied under this person's unconfirmed edits. */
  remoteOp(op: Op): void {
    this.history.remote(op);
    this.index.sync(this.board.takeDirty());
    this.pruneSelection();
    if (this.editing) {
      const el = this.board.get(this.editing.id);
      if (!el) this.editing = null;
      else {
        const len = el.text?.text.length ?? 0;
        this.editing = { ...this.editing, anchor: Math.min(this.editing.anchor, len), head: Math.min(this.editing.head, len) };
      }
    }
    this.changed();
  }

  /** The board was replaced (a fresh copy from the room). */
  replaceBoard(board: Board): void {
    this.board = board;
    this.index = new SpatialIndex(board);
    this.index.rebuild();
    this.history.clear();
    this.editing = null;
    this.pruneSelection();
    this.changed();
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    if (readOnly) {
      this.editing = null;
      if (this.tool !== 'hand' && this.tool !== 'comment') this.tool = 'select';
    }
    this.changed();
  }

  private pruneSelection(): void {
    for (const id of [...this.selection]) if (!this.board.get(id)) this.selection.delete(id);
    if (this.editing && !this.board.get(this.editing.id)) this.editing = null;
  }

  // ---------------------------------------------------------------- selection

  select(ids: Iterable<string>): void {
    this.endEditing();
    this.selection = new Set(ids);
    this.pruneSelection();
    this.changed();
  }

  selectAll(): void {
    this.select(this.board.childIds(null).filter((id) => !this.board.get(id)?.locked));
  }

  get selected(): BoardElement[] {
    return [...this.selection].map((id) => this.board.get(id)).filter((e): e is BoardElement => !!e);
  }

  /** The selection's bounds, or null. */
  selectionRect(): Rect | null {
    return selectionBounds(this.board, this.selection);
  }

  // ---------------------------------------------------------------- tools

  setTool(tool: ToolKind, locked = false): void {
    this.tool = tool;
    this.toolLocked = locked;
    if (isDrawingTool(tool)) this.toolOptions = { ...this.toolOptions, drawingTool: tool };
    this.endEditing();
    this.transient = {};
    this.changed();
  }

  setToolOptions(patch: Partial<ToolOptions>): void {
    this.toolOptions = { ...this.toolOptions, ...patch };
    this.changed();
  }

  /** Back to the select tool after making something, unless the tool is locked. */
  toolDone(): void {
    if (!this.toolLocked) this.tool = 'select';
  }

  // ---------------------------------------------------------------- camera

  setViewport(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) };
    // Presenting fills the window: a slide is fitted again to the new size.
    const slide = this.presenting && this.slide ? this.board.get(this.slide) : undefined;
    if (slide) this.camera = fitRect({ x: slide.x, y: slide.y, w: slide.w, h: slide.h }, this.viewport.width, this.viewport.height, { margin: 24, maxZoom: 8 });
    this.changed(!!slide);
  }

  setCamera(camera: Camera, react = false): void {
    this.camera = camera;
    this.changed(react);
  }

  zoomTo(zoom: number, around?: Point): void {
    const p = around ?? { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    this.camera = zoomAt(this.camera, zoom, p);
    this.changed();
  }

  /** Shows a board rectangle. */
  showRect(r: Rect, options: { maxZoom?: number; margin?: number } = {}): void {
    this.camera = fitRect(r, this.viewport.width, this.viewport.height, options);
    this.changed();
  }

  zoomToFit(): void {
    const all = selectionBounds(this.board, this.board.elements.keys());
    if (all) this.showRect(all);
    else this.camera = { x: -this.viewport.width / 2, y: -this.viewport.height / 2, zoom: 1 };
    this.changed();
  }

  zoomToSelection(): void {
    const r = this.selectionRect();
    if (r) this.showRect(r, { maxZoom: 2 });
  }

  visible(): Rect {
    return visibleRect(this.camera, this.viewport.width, this.viewport.height);
  }

  /**
   * Brings a board rectangle into view, moving as little as possible and
   * keeping the zoom (zooming out only when it can't fit). Nothing moves when
   * it is already in view.
   */
  reveal(r: Rect, margin = 48): void {
    const v = this.visible();
    const m = margin / this.camera.zoom;
    if (r.w + m * 2 > v.w || r.h + m * 2 > v.h) {
      this.showRect(r, { maxZoom: this.camera.zoom, margin });
      return;
    }
    const shift = (start: number, size: number, from: number, span: number): number => {
      if (start - m < from) return start - m - from;
      if (start + size + m > from + span) return start + size + m - (from + span);
      return 0;
    };
    const dx = shift(r.x, r.w, v.x, v.w);
    const dy = shift(r.y, r.h, v.y, v.h);
    if (dx || dy) this.setCamera({ ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy }, true);
  }

  /** The board point at the centre of the screen. */
  center(): Point {
    const v = this.visible();
    return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  }

  // ---------------------------------------------------------------- presence

  presence(): BoardPresence {
    const v = this.visible();
    const p: BoardPresence = {
      cursor: this.cursor ? [Math.round(this.cursor.x), Math.round(this.cursor.y)] : null,
      selection: [...this.selection].slice(0, 500),
      editing: this.editing?.id ?? null,
      caret: this.editing ? [this.editing.anchor, this.editing.head] : null,
      viewport: [Math.round(v.x), Math.round(v.y), Math.round(v.w), Math.round(v.h)],
      tool: this.tool,
      following: this.following,
      presenting: this.presenting,
      slide: this.slide,
      reaction: this.reaction,
    };
    return p;
  }

  setPeers(peers: BoardPeer[]): void {
    this.peers = peers;
    if (this.following) {
      const peer = peers.find((p) => p.clientId === this.following);
      if (!peer) this.following = null;
      else this.followViewport(peer);
    }
    this.changed();
  }

  follow(clientId: string | null): void {
    this.following = clientId;
    const peer = clientId ? this.peers.find((p) => p.clientId === clientId) : undefined;
    if (peer) this.followViewport(peer);
    this.changed();
  }

  private followViewport(peer: BoardPeer): void {
    const vp = peer.presence?.viewport;
    if (!vp) return;
    this.camera = fitRect({ x: vp[0], y: vp[1], w: vp[2], h: vp[3] }, this.viewport.width, this.viewport.height, { margin: 0, maxZoom: 40 });
  }

  /** Jumps to where a collaborator is. */
  goToPeer(peer: BoardPeer): void {
    const vp = peer.presence?.viewport;
    if (vp) this.showRect({ x: vp[0], y: vp[1], w: vp[2], h: vp[3] }, { margin: 0, maxZoom: 40 });
    else if (peer.presence?.cursor) {
      const [x, y] = peer.presence.cursor;
      this.camera = { ...this.camera, x: x - this.viewport.width / 2 / this.camera.zoom, y: y - this.viewport.height / 2 / this.camera.zoom };
      this.changed();
    }
  }

  // ---------------------------------------------------------------- editing helpers

  /** Elements that carry text the editor can edit. */
  canEditText(el: BoardElement | undefined): boolean {
    return !!el && !el.locked && keyAllowed(el.type, 'text') && el.type !== 'connector';
  }

  startEditing(id: string, at?: number): void {
    const el = this.board.get(id);
    if (this.readOnly || !el || !(this.canEditText(el) || el.type === 'connector')) return;
    const len = el.text?.text.length ?? 0;
    const pos = at === undefined ? len : Math.min(at, len);
    this.selection = new Set([id]);
    this.editing = { id, anchor: at === undefined ? 0 : pos, head: pos };
    this.changed();
  }

  stopEditing(): void {
    if (!this.editing) return;
    this.endEditing();
    this.changed();
  }

  /** Ends text editing: seals its undo step and drops the box if it was left empty. */
  private endEditing(): void {
    if (!this.editing) return;
    const { id } = this.editing;
    this.history.seal();
    this.editing = null;
    this.removeIfEmptyText(id);
  }

  /**
   * A text box left without any text is invisible on the board, so it goes
   * when editing stops. One that was only just made leaves no undo step
   * behind, so undo never brings back an empty box.
   */
  private removeIfEmptyText(id: string): void {
    const el = this.board.get(id);
    if (this.readOnly || !el || el.type !== 'text' || el.text?.text.trim()) return;
    const last = this.history.undoStack[this.history.undoStack.length - 1];
    const justMade = !!last && unbatch(last.op).every((o) => o.type === 'create' && o.elements.every((e) => e.id === id));
    if (justMade) this.history.undoStack.pop();
    this.apply(deleteOps(this.board, [id]), { select: [], undoable: !justMade });
  }

  /** The editing element's text layout, in board units. */
  editingLayout(): ReturnType<typeof elementTextLayout> {
    const el = this.editing ? this.board.get(this.editing.id) : undefined;
    if (!el) return null;
    return elementTextLayout(el, { measurer: this.measurer, showAuthors: this.showAuthors });
  }

  /** Deletes the selection (with contents), keeping connectors where they were drawn. */
  deleteSelection(): void {
    if (!this.selection.size) return;
    const ids = this.selected.filter((e) => !e.locked).map((e) => e.id);
    this.apply(deleteOps(this.board, ids), { select: [] });
  }

  /** An element's bounds in board units. */
  boundsOf(el: BoardElement): Rect {
    return this.index.boundsOf(el.id) ?? elementBounds(this.board, el);
  }

  connectorPoints(el: BoardElement): Point[] {
    return connectorGeometry(this.board, el).points;
  }

  /** Applies ops that only this replica holds (the signed-out preview, tests). */
  applyBatch(ops: Op[], options: { gesture?: string; select?: Iterable<string> } = {}): boolean {
    return this.apply(batch(ops), options);
  }
}
