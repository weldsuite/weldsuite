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
  type Point,
} from '@weldsuite/board-engine';
import type { BoardController } from '../model/board-controller';
import { toScreen } from '../model/camera';
import { handlePositions, selectionFrame, type Interactions } from '../model/interactions';

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
  const cam = c.camera;
  const t = c.transient;

  // Drop target frame.
  if (t.dropTarget) {
    const f = c.board.get(t.dropTarget);
    if (f) {
      ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
      const a = toScreen(cam, { x: f.x, y: f.y });
      ctx.fillRect(a.x, a.y, f.w * cam.zoom, f.h * cam.zoom);
      outline(ctx, c, f, SELECTION_COLOR, 2);
    }
  }

  // Hover.
  if (t.hover && !c.selection.has(t.hover)) {
    const el = c.board.get(t.hover);
    if (el && el.type !== 'frame') outline(ctx, c, el, 'rgba(37, 99, 235, 0.55)', 1.5);
  }

  // Collaborators' selections, in their colour.
  for (const peer of c.peers) {
    for (const id of peer.presence?.selection ?? []) {
      const el = c.board.get(id);
      if (el) outline(ctx, c, el, peer.color, 2);
    }
  }

  // The selection.
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
  if (!ia.dragging || t.guides) {
    for (const { handle, at } of handlePositions(c)) {
      ctx.beginPath();
      if (handle.kind === 'connect') {
        ctx.fillStyle = 'rgba(37, 99, 235, 0.9)';
        ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      if (handle.kind === 'rotate') {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 1.5;
        ctx.arc(at.x, at.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 1.5;
      if (handle.kind === 'resize') ctx.rect(at.x - 4.5, at.y - 4.5, 9, 9);
      else ctx.arc(at.x, at.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Text being edited: selection and caret.
  if (c.editing) {
    const el = c.board.get(c.editing.id);
    const tl = el ? elementTextLayout(el, { measurer: c.measurer }) : null;
    if (el && tl) {
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
      const from = Math.min(c.editing.anchor, c.editing.head);
      const to = Math.max(c.editing.anchor, c.editing.head);
      ctx.fillStyle = 'rgba(37, 99, 235, 0.25)';
      for (const r of selectionRects(tl.layout, from, to)) ctx.fillRect(tl.x + r.x, tl.y + r.y, r.w, r.h);
      if (options.caretVisible && from === to) {
        const caret = caretRect(tl.layout, c.editing.head);
        ctx.fillStyle = '#111827';
        ctx.fillRect(tl.x + caret.x - 0.75 / cam.zoom, tl.y + caret.y, 1.5 / cam.zoom, caret.h);
      }
      ctx.restore();
    }
  }

  // Collaborators editing text: a bar where their caret is.
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

  // Marquee.
  if (t.marquee) {
    const a = toScreen(cam, { x: t.marquee.x, y: t.marquee.y });
    ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.8)';
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, t.marquee.w * cam.zoom, t.marquee.h * cam.zoom);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, t.marquee.w * cam.zoom, t.marquee.h * cam.zoom);
  }

  // Snapping guides.
  if (t.guides?.length) {
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const g of t.guides) {
      const a = toScreen(cam, g.axis === 'x' ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
      const b = toScreen(cam, g.axis === 'x' ? { x: g.at, y: g.to } : { x: g.to, y: g.at });
      ctx.moveTo(a.x + 0.5, a.y + 0.5);
      ctx.lineTo(b.x + 0.5, b.y + 0.5);
    }
    ctx.stroke();
  }

  // Shape or frame being drawn.
  if (t.creating && (t.creating.w > 0 || t.creating.h > 0)) {
    const a = toScreen(cam, { x: t.creating.x, y: t.creating.y });
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(a.x, a.y, t.creating.w * cam.zoom, t.creating.h * cam.zoom);
    ctx.setLineDash([]);
  }

  // Connector being drawn.
  if (t.connector) {
    const pts = t.connector.points.map((p) => toScreen(cam, p));
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    if (t.connector.target) {
      const el = c.board.get(t.connector.target);
      if (el) outline(ctx, c, el, SELECTION_COLOR, 2);
    }
  }

  // Pen stroke being drawn.
  if (t.stroke && t.stroke.points.length > 1) {
    ctx.save();
    ctx.globalAlpha = t.stroke.opacity;
    ctx.strokeStyle = t.stroke.color;
    ctx.lineWidth = t.stroke.width * cam.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    t.stroke.points.forEach((q, i) => {
      const p = toScreen(cam, q);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Strokes the eraser is taking.
  for (const id of t.erasing ?? []) {
    const el = c.board.get(id);
    if (el) outline(ctx, c, el, '#ef4444', 2);
  }

  // Comment pins (always on top).
  for (const el of c.board.paintOrder()) {
    if (el.type !== 'comment') continue;
    const at = toScreen(cam, { x: el.x, y: el.y });
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

  // Vote counts.
  for (const [id, n] of options.votes ?? []) {
    const el = c.board.get(id);
    if (!el || n === 0) continue;
    const at = toScreen(cam, { x: el.x + el.w, y: el.y });
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

  // Collaborators' cursors with their names.
  for (const peer of c.peers) {
    const cursor = peer.presence?.cursor;
    if (!cursor) continue;
    const at = toScreen(cam, { x: cursor[0], y: cursor[1] });
    if (at.x < -40 || at.y < -40 || at.x > c.viewport.width + 40 || at.y > c.viewport.height + 40) continue;
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
}
