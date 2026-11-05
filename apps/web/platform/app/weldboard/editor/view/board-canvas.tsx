import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { Point, RecordRef, RecordView } from '@weldsuite/board-engine';
import type { BoardController } from '../model/board-controller';
import { toBoard, toScreen } from '../model/camera';
import { cutSelection, encodeClipboard, fragmentFromHtml, pasteFragment, pasteText } from '../model/clipboard';
import type { Interactions, PointerInfo } from '../model/interactions';
import { handleKey, type KeyActions } from '../model/keyboard';
import { insertText } from '../model/text-editing';
import { drawOverlay } from './overlay';
import { BoardRenderer } from './renderer';

export interface BoardCanvasProps {
  controller: BoardController;
  interactions: Interactions;
  loadImage: (src: string) => Promise<string | null>;
  record?: (ref: RecordRef) => RecordView | null;
  /** Bumped when record cards' data changed (redraw them). */
  recordVersion?: number;
  /** Image files dropped or pasted on the board, with the board point they landed on. */
  onFiles?: (files: File[], at: Point) => void;
  /** A URL pasted on its own (a link card). */
  onPasteUrl?: (url: string, at: Point) => void;
  /** The pointer moved (presence). */
  onPointer?: () => void;
  onContextMenu?: (screen: Point) => void;
  keyActions?: KeyActions;
  votes?: Map<string, number>;
  commentCounts?: Map<string, number>;
  activeComment?: string | null;
  /** Element ids drawn faded (a voting session's scope, a search). */
  faded?: ReadonlySet<string>;
  renaming: string | null;
  onRenamed: (id: string, name: string | null) => void;
  labels: { renameFrame: string; board: string };
}

function pointerInfo(e: { clientX: number; clientY: number; button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; pressure?: number; pointerType?: string }, rect: DOMRect): PointerInfo {
  return {
    screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    button: e.button,
    shift: e.shiftKey,
    alt: e.altKey,
    mod: e.ctrlKey || e.metaKey,
    pressure: e.pressure ?? 0.5,
    pointerType: e.pointerType ?? 'mouse',
  };
}

const URL_RE = /^https?:\/\/\S+$/i;

/** Keeps the hidden textarea at the element being edited, so the IME's candidate window shows there. */
function placeInput(el: HTMLTextAreaElement | null, c: BoardController): void {
  if (!el) return;
  const editing = c.editing ? c.board.get(c.editing.id) : undefined;
  if (!editing) {
    el.style.transform = 'translate(-1000px, -1000px)';
    return;
  }
  const at = toScreen(c.camera, { x: editing.x, y: editing.y });
  el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
}

/** Inputs, textareas, selects and editable content: they keep their keys. */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * The board's two canvases (content, then the overlay on top) and the hidden
 * textarea that takes keyboard and IME input. Drawing happens outside React:
 * the controller tells the canvas to redraw, and the canvas draws on the next
 * animation frame.
 */
export function BoardCanvas(props: BoardCanvasProps) {
  const { controller: c, interactions: ia } = props;
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState('default');
  const composing = useRef(false);
  const caretOn = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;
  const renameRef = useRef<HTMLInputElement>(null);

  // Rendering.
  useEffect(() => {
    const host = container.current;
    const cv = content.current;
    const ov = overlay.current;
    if (!host || !cv || !ov) return;
    const renderer = new BoardRenderer(c, {
      loadImage: (src) => propsRef.current.loadImage(src),
      record: (ref) => propsRef.current.record?.(ref) ?? null,
      requestRedraw: () => schedule(true),
    });
    rendererRef.current = renderer;
    let frame = 0;
    let contentDirty = true;
    let lastKey = '';
    const draw = () => {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = c.viewport;
      const key = `${c.board.version}|${c.camera.x}|${c.camera.y}|${c.camera.zoom}|${width}|${height}|${dpr}|${c.showAuthors}|${c.showGrid}|${renderer.recordVersion}|${propsRef.current.faded?.size ?? 0}`;
      if (contentDirty || key !== lastKey) {
        lastKey = key;
        contentDirty = false;
        const ctx = cv.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          renderer.drawContent(ctx, width, height, { faded: propsRef.current.faded });
        }
      }
      const octx = ov.getContext('2d');
      if (octx) {
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.clearRect(0, 0, width, height);
        drawOverlay(octx, c, ia, {
          caretVisible: caretOn.current,
          votes: propsRef.current.votes,
          commentCounts: propsRef.current.commentCounts,
          activeComment: propsRef.current.activeComment,
        });
      }
      placeInput(input.current, c);
    };
    const schedule = (force = false) => {
      if (force) contentDirty = true;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const resize = () => {
      const r = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of [cv, ov]) {
        canvas.width = Math.max(1, Math.round(r.width * dpr));
        canvas.height = Math.max(1, Math.round(r.height * dpr));
        canvas.style.width = `${r.width}px`;
        canvas.style.height = `${r.height}px`;
      }
      c.setViewport(r.width, r.height);
      schedule(true);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const off = c.onRender(() => schedule());
    // Web fonts finishing changes text widths.
    void document.fonts?.ready.then(() => {
      (c.measurer as { clear?: () => void }).clear?.();
      schedule(true);
    });
    const blink = window.setInterval(() => {
      if (!c.editing) return;
      caretOn.current = !caretOn.current;
      schedule();
    }, 530);
    const prune = window.setInterval(() => renderer.prune(), 30_000);
    return () => {
      observer.disconnect();
      off();
      window.clearInterval(blink);
      window.clearInterval(prune);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [c, ia]);

  const rendererRef = useRef<BoardRenderer | null>(null);
  useEffect(() => {
    rendererRef.current?.invalidateRecords();
  }, [props.recordVersion]);
  useEffect(() => {
    c.changed(false);
  }, [c, props.votes, props.commentCounts, props.activeComment, props.faded]);

  // Focus stays on the textarea, so keys and IME go there. The shell moves
  // focus to <main> after navigating; whenever nothing else that takes text
  // has focus, the board takes it back.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [c]);
  useEffect(() => {
    const reclaim = () => {
      if (propsRef.current.renaming || document.activeElement === input.current) return;
      if (isTextField(document.activeElement) && !container.current?.contains(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      input.current?.focus({ preventScroll: true });
    };
    const off = c.subscribe(reclaim);
    // Keys pressed while focus is elsewhere on the page (not in a field): handled as board keys.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.target === input.current || isTextField(e.target as Element | null)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const handled = handleKey(c, ia, { key: e.key, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey, composing: e.isComposing }, propsRef.current.keyActions);
      if (handled) e.preventDefault();
      else if (c.editing && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        insertText(c, e.key);
      }
      input.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, [c, ia]);

  // Space held: pan with the pointer.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !c.editing && document.activeElement === input.current) {
        ia.spaceDown = true;
        setCursor('grab');
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        ia.spaceDown = false;
        setCursor('default');
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [c, ia]);

  // Wheel: native listener, since React's is passive and cannot prevent page zoom.
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const lineScale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      ia.wheel({ x: e.clientX - r.left, y: e.clientY - r.top }, e.deltaX * lineScale, e.deltaY * lineScale, e.ctrlKey || e.metaKey);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ia]);

  const rect = () => overlay.current!.getBoundingClientRect();

  const onCopy = (e: ClipboardEvent) => {
    const data = encodeClipboard(c);
    if (!data) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', data.text);
    if (data.html) e.clipboardData.setData('text/html', data.html);
  };

  const pastePoint = (): Point => c.cursor ?? c.center();

  const onPaste = (e: ClipboardEvent) => {
    if (c.readOnly) return;
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    const fragment = html ? fragmentFromHtml(html) : null;
    if (fragment && !c.editing) {
      pasteFragment(c, fragment, pastePoint());
      return;
    }
    if (files.length && !c.editing) {
      props.onFiles?.(files, pastePoint());
      return;
    }
    if (!c.editing && URL_RE.test(text.trim()) && props.onPasteUrl) {
      props.onPasteUrl(text.trim(), pastePoint());
      return;
    }
    pasteText(c, text, pastePoint());
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (c.readOnly) return;
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const r = rect();
    props.onFiles?.(files, toBoard(c.camera, { x: e.clientX - r.left, y: e.clientY - r.top }));
  };

  return (
    <div
      ref={container}
      className="relative h-full w-full touch-none select-none overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <canvas ref={content} className="absolute inset-0" aria-hidden="true" />
      <canvas
        ref={overlay}
        className="absolute inset-0"
        style={{ cursor }}
        aria-hidden="true"
        onPointerDown={(e) => {
          input.current?.focus({ preventScroll: true });
          if (e.pointerType === 'touch' && ia.touchDown(e.pointerId, pointerInfo(e, rect()).screen)) return;
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
          ia.down(pointerInfo(e, rect()));
          setCursor(ia.cursorAt(pointerInfo(e, rect()).screen));
        }}
        onPointerMove={(e) => {
          const info = pointerInfo(e, rect());
          if (e.pointerType === 'touch' && ia.touchMove(e.pointerId, info.screen)) return;
          ia.move(info);
          props.onPointer?.();
          if (!ia.dragging) {
            const next = ia.cursorAt(info.screen);
            if (next !== cursor) setCursor(next);
          }
        }}
        onPointerUp={(e) => {
          if (e.pointerType === 'touch' && ia.touchUp(e.pointerId)) return;
          ia.up(pointerInfo(e, rect()));
          setCursor(ia.cursorAt(pointerInfo(e, rect()).screen));
        }}
        onPointerCancel={() => ia.cancel()}
        onPointerLeave={() => {
          if (!ia.dragging) {
            c.cursor = null;
            props.onPointer?.();
          }
        }}
        onDoubleClick={(e) => ia.doubleClick(pointerInfo(e, rect()))}
        onContextMenu={(e) => {
          e.preventDefault();
          const r = rect();
          props.onContextMenu?.({ x: e.clientX - r.left, y: e.clientY - r.top });
        }}
      />
      <textarea
        ref={input}
        aria-label={props.labels.board}
        className="absolute left-0 top-0 h-6 w-6 resize-none border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(e) => {
          const handled = handleKey(c, ia, { key: e.key, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey, composing: e.nativeEvent.isComposing || composing.current }, props.keyActions);
          if (handled) {
            e.preventDefault();
            caretOn.current = true;
          }
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          if (c.editing && e.data) insertText(c, e.data);
          e.currentTarget.value = '';
        }}
        onInput={(e) => {
          if (composing.current) return;
          const value = e.currentTarget.value;
          e.currentTarget.value = '';
          if (!value) return;
          // Text arriving without a key press (IME, dictation, paste-as-typing) on a selected element starts editing it.
          if (!c.editing && c.selection.size === 1 && !c.readOnly) {
            const el = c.selected[0]!;
            if (c.canEditText(el)) c.editing = { id: el.id, anchor: 0, head: el.text?.text.length ?? 0 };
          }
          if (c.editing) {
            caretOn.current = true;
            insertText(c, value);
          }
        }}
        onCopy={onCopy}
        onCut={(e) => {
          onCopy(e);
          if (!c.readOnly) cutSelection(c);
        }}
        onPaste={onPaste}
      />
      {props.renaming && <FrameRename key={props.renaming} controller={c} id={props.renaming} inputRef={renameRef} onDone={props.onRenamed} label={props.labels.renameFrame} />}
    </div>
  );
}

function FrameRename({ controller: c, id, inputRef, onDone, label }: { controller: BoardController; id: string; inputRef: React.RefObject<HTMLInputElement | null>; onDone: (id: string, name: string | null) => void; label: string }) {
  const el = c.board.get(id);
  const [value, setValue] = useState(el?.name ?? '');
  useEffect(() => {
    inputRef.current?.select();
  }, [inputRef]);
  if (!el) return null;
  const at = toScreen(c.camera, { x: el.x, y: el.y });
  return (
    <input
      ref={inputRef}
      aria-label={label}
      autoFocus
      value={value}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(id, value.trim());
        if (e.key === 'Escape') onDone(id, null);
        e.stopPropagation();
      }}
      onBlur={() => onDone(id, value.trim())}
      className="absolute rounded border border-primary bg-background px-1 text-sm font-semibold shadow-sm outline-none"
      style={{ left: at.x, top: at.y - 30, width: Math.max(160, Math.min(400, el.w * c.camera.zoom)) }}
    />
  );
}
