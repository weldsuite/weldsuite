/**
 * The overlay drawn over the board in screen pixels: selection outlines and
 * handles, hover, the marquee, snapping guides, shapes and connectors being
 * drawn, the text caret, collaborators' cursors and selections, comment pins
 * and vote counts. Redrawn far more often than the board itself.
 */

import {
  caretRect,
  connectorGeometry,
  corners,
  elementBounds,
  elementTextLayout,
  rotatePoint,
  selectionRects,
  SELECTION_COLOR,
  type BoardElement,
  type BoardPeer,
  type Point,
} from '@weldsuite/board-engine';
import type { BoardController } from '../model/board-controller';
import { toScreen } from '../model/camera';
import { handlePositions, selectionFrame, type Handle, type Interactions } from '../model/interactions';

export interface OverlayOptions {
  caretVisible: boolean;
  /** Vote counts by element (an open voting session). */
  votes?: Map<string, number>;
  /** Comment pins: unresolved replies count by thread. */
  commentCounts?: Map<string, number>;
  activeComment?: string | null;
}

function outline(ctx: CanvasRenderingContext2D, c: BoardController, el: BoardElement, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (el.type === 'connector') {
    const pts = connectorGeometry(c.board, el).points.map((p) => toScreen(c.camera, p));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    return;
  }
  const pts = (el.type === 'pen' ? boxCorners(elementBounds(c.board, el)) : corners(el)).map((p) => toScreen(c.camera, p));
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
}

function boxCorners(b: { x: number; y: number; w: number; h: number }): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

export function drawOverlay(ctx: CanvasRenderingContext2D, c: BoardController, ia: Interactions, options: OverlayOptions): void {
  drawDropTarget(ctx, c);
  drawHover(ctx, c);
  drawPeerSelections(ctx, c);
  drawSelection(ctx, c, ia);
  drawEditedText(ctx, c, options.caretVisible);
  drawPeerCarets(ctx, c);
  drawMarquee(ctx, c);
  drawGuides(ctx, c);
  drawCreating(ctx, c);
  drawConnectorPreview(ctx, c);
  drawStrokePreview(ctx, c);
  drawErasing(ctx, c);
  // Comment pins (always on top).
  for (const el of c.board.paintOrder()) {
    if (el.type === 'comment') drawCommentPin(ctx, c, el, options);
  }
  drawVotes(ctx, c, options.votes);
  // Collaborators' cursors with their names.
  for (const peer of c.peers) drawPeerCursor(ctx, c, peer);
}

/** Drop target frame. */
function drawDropTarget(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const cam = c.camera;
  const target = c.transient.dropTarget;
  if (!target) return;
  const f = c.board.get(target);
  if (!f) return;
  ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
  const a = toScreen(cam, { x: f.x, y: f.y });
  ctx.fillRect(a.x, a.y, f.w * cam.zoom, f.h * cam.zoom);
  outline(ctx, c, f, SELECTION_COLOR, 2);
}

function drawHover(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const hover = c.transient.hover;
  if (!hover || c.selection.has(hover)) return;
  const el = c.board.get(hover);
  if (el && el.type !== 'frame') outline(ctx, c, el, 'rgba(37, 99, 235, 0.55)', 1.5);
}

/** Collaborators' selections, in their colour. */
function drawPeerSelections(ctx: CanvasRenderingContext2D, c: BoardController): void {
  for (const peer of c.peers) {
    for (const id of peer.presence?.selection ?? []) {
      const el = c.board.get(id);
      if (el) outline(ctx, c, el, peer.color, 2);
    }
  }
}

/** The selection: outlines, a dashed box around several elements, and the handles. */
function drawSelection(ctx: CanvasRenderingContext2D, c: BoardController, ia: Interactions): void {
  const cam = c.camera;
  const sel = c.selected;
  for (const el of sel) outline(ctx, c, el, SELECTION_COLOR, el.locked ? 1 : 1.5);
  const frame = selectionFrame(c);
  if (frame && sel.length > 1) {
    const { box } = frame;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1;
    const a = toScreen(cam, { x: box.x, y: box.y });
    ctx.strokeRect(a.x, a.y, box.w * cam.zoom, box.h * cam.zoom);
    ctx.setLineDash([]);
  }
  if (!ia.dragging || c.transient.guides) {
    for (const { handle, at } of handlePositions(c)) drawHandle(ctx, handle, at);
  }
}

function drawHandle(ctx: CanvasRenderingContext2D, handle: Handle, at: Point): void {
  ctx.beginPath();
  if (handle.kind === 'connect') {
    ctx.fillStyle = 'rgba(37, 99, 235, 0.9)';
    ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (handle.kind === 'rotate') {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1.5;
    ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    return;
  }
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 1.5;
  if (handle.kind === 'resize') ctx.rect(at.x - 4.5, at.y - 4.5, 9, 9);
  else ctx.arc(at.x, at.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Text being edited: selection and caret. */
function drawEditedText(ctx: CanvasRenderingContext2D, c: BoardController, caretVisible: boolean): void {
  const cam = c.camera;
  const editing = c.editing;
  if (!editing) return;
  const el = c.board.get(editing.id);
  const tl = el ? elementTextLayout(el, { measurer: c.measurer }) : null;
  if (!el || !tl) return;
  ctx.save();
  ctx.translate(-cam.x * cam.zoom, -cam.y * cam.zoom);
  ctx.scale(cam.zoom, cam.zoom);
  if (el.rotation) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(el.rotation);
    ctx.translate(-cx, -cy);
  }
  const from = Math.min(editing.anchor, editing.head);
  const to = Math.max(editing.anchor, editing.head);
  ctx.fillStyle = 'rgba(37, 99, 235, 0.25)';
  for (const r of selectionRects(tl.layout, from, to)) ctx.fillRect(tl.x + r.x, tl.y + r.y, r.w, r.h);
  if (caretVisible && from === to) {
    const caret = caretRect(tl.layout, editing.head);
    ctx.fillStyle = '#111827';
    ctx.fillRect(tl.x + caret.x - 0.75 / cam.zoom, tl.y + caret.y, 1.5 / cam.zoom, caret.h);
  }
  ctx.restore();
}

/** Collaborators editing text: a bar where their caret is. */
function drawPeerCarets(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const cam = c.camera;
  for (const peer of c.peers) {
    const p = peer.presence;
    if (!p?.editing || !p.caret) continue;
    const el = c.board.get(p.editing);
    const tl = el ? elementTextLayout(el, { measurer: c.measurer }) : null;
    if (!el || !tl) continue;
    const caret = caretRect(tl.layout, Math.min(p.caret[1], el.text?.text.length ?? 0));
    const at = toScreen(cam, rotatePoint({ x: tl.x + caret.x, y: tl.y + caret.y }, { x: el.x + el.w / 2, y: el.y + el.h / 2 }, el.rotation ?? 0));
    ctx.fillStyle = peer.color;
    ctx.fillRect(at.x - 1, at.y, 2, caret.h * cam.zoom);
  }
}

function drawMarquee(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const cam = c.camera;
  const marquee = c.transient.marquee;
  if (!marquee) return;
  const a = toScreen(cam, { x: marquee.x, y: marquee.y });
  ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
  ctx.strokeStyle = 'rgba(37, 99, 235, 0.8)';
  ctx.lineWidth = 1;
  ctx.fillRect(a.x, a.y, marquee.w * cam.zoom, marquee.h * cam.zoom);
  ctx.strokeRect(a.x + 0.5, a.y + 0.5, marquee.w * cam.zoom, marquee.h * cam.zoom);
}

/** Snapping guides. */
function drawGuides(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const cam = c.camera;
  const guides = c.transient.guides;
  if (!guides?.length) return;
  ctx.strokeStyle = '#ec4899';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of guides) {
    const a = toScreen(cam, g.axis === 'x' ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
    const b = toScreen(cam, g.axis === 'x' ? { x: g.at, y: g.to } : { x: g.to, y: g.at });
    ctx.moveTo(a.x + 0.5, a.y + 0.5);
    ctx.lineTo(b.x + 0.5, b.y + 0.5);
  }
  ctx.stroke();
}

/** Shape or frame being drawn. */
function drawCreating(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const cam = c.camera;
  const creating = c.transient.creating;
  if (creating && (creating.w > 0 || creating.h > 0)) {
    const a = toScreen(cam, { x: creating.x, y: creating.y });
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(a.x, a.y, creating.w * cam.zoom, creating.h * cam.zoom);
    ctx.setLineDash([]);
  }
}

/** Connector being drawn. */
function drawConnectorPreview(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const connector = c.transient.connector;
  if (!connector) return;
  const pts = connector.points.map((p) => toScreen(c.camera, p));
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
  if (connector.target) {
    const el = c.board.get(connector.target);
    if (el) outline(ctx, c, el, SELECTION_COLOR, 2);
  }
}

/** Pen stroke being drawn. */
function drawStrokePreview(ctx: CanvasRenderingContext2D, c: BoardController): void {
  const cam = c.camera;
  const stroke = c.transient.stroke;
  if (stroke && stroke.points.length > 1) {
    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width * cam.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    stroke.points.forEach((q, i) => {
      const p = toScreen(cam, q);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();
  }
}

/** Strokes the eraser is taking. */
function drawErasing(ctx: CanvasRenderingContext2D, c: BoardController): void {
  for (const id of c.transient.erasing ?? []) {
    const el = c.board.get(id);
    if (el) outline(ctx, c, el, '#ef4444', 2);
  }
}

/** A comment pin, with the number of replies on it. */
function drawCommentPin(ctx: CanvasRenderingContext2D, c: BoardController, el: BoardElement, options: OverlayOptions): void {
  const at = toScreen(c.camera, { x: el.x, y: el.y });
  const active = options.activeComment === el.thread || c.selection.has(el.id);
  const size = active ? 30 : 26;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.2)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = el.resolved ? '#9ca3af' : '#f59e0b';
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(at.x, at.y - size * 0.6);
  ctx.arcTo(at.x, at.y - size, at.x + size * 0.4, at.y - size, size * 0.4);
  ctx.lineTo(at.x + size * 0.6, at.y - size);
  ctx.arcTo(at.x + size, at.y - size, at.x + size, at.y - size * 0.6, size * 0.4);
  ctx.lineTo(at.x + size, at.y - size * 0.4);
  ctx.arcTo(at.x + size, at.y, at.x + size * 0.6, at.y, size * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const count = options.commentCounts?.get(el.thread ?? '') ?? 0;
  if (count > 0) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.round(size * 0.45)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(count), at.x + size / 2, at.y - size * 0.35);
    ctx.textAlign = 'left';
  }
}

/** Vote counts. */
function drawVotes(ctx: CanvasRenderingContext2D, c: BoardController, votes: Map<string, number> | undefined): void {
  for (const [id, n] of votes ?? []) {
    const el = c.board.get(id);
    if (!el || n === 0) continue;
    const at = toScreen(c.camera, { x: el.x + el.w, y: el.y });
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(at.x, at.y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), at.x, at.y + 0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
}

/** A collaborator's cursor with their name, and the reaction they just sent. */
function drawPeerCursor(ctx: CanvasRenderingContext2D, c: BoardController, peer: BoardPeer): void {
  const cursor = peer.presence?.cursor;
  if (!cursor) return;
  const at = toScreen(c.camera, { x: cursor[0], y: cursor[1] });
  if (at.x < -40 || at.y < -40 || at.x > c.viewport.width + 40 || at.y > c.viewport.height + 40) return;
  ctx.fillStyle = peer.color;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(at.x, at.y + 16);
  ctx.lineTo(at.x + 4.5, at.y + 12);
  ctx.lineTo(at.x + 11, at.y + 12);
  ctx.closePath();
  ctx.fill();
  ctx.font = '500 12px Inter, sans-serif';
  const label = peer.name;
  const w = ctx.measureText(label).width + 12;
  ctx.beginPath();
  ctx.roundRect(at.x + 10, at.y + 16, w, 20, 6);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, at.x + 16, at.y + 30);
  const reaction = peer.presence?.reaction;
  if (reaction && Date.now() - reaction[1] < 3000) {
    ctx.font = '28px sans-serif';
    ctx.fillText(reaction[0], at.x + 12, at.y - 6);
  }
}
