import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { caretRect, isSafeLink, pageDisplay, selectionRects, type PageLayout } from '@weldsuite/docs-engine';
import { useI18n } from '@/lib/i18n/provider';
import { DocContextMenu } from '../context-menu';
import { ImageOverlay } from '../image-overlay';
import type { DocController } from '../model/doc-controller';
import { FRAGMENT_TYPE } from '../model/clipboard';
import { selectedImage } from '../model/image-actions';
import { handleKey } from '../model/keyboard';
import { PageContent } from './page-content';
import { ColumnHandles } from './table-handles';

/** Screen pixels per point at 100 %. */
export const PX_PER_PT = 96 / 72;
const PAGE_GAP = 12;
const PAD_TOP = 16;
/** Pages rendered above and below the visible ones. */
const OVERSCAN_PX = 1200;

/**
 * The pages, stacked and centred, rendered only near the viewport. Typing
 * goes into a hidden textarea kept at the caret, so the browser's input
 * methods (IME, dead keys, dictation, mobile keyboards) all work; the
 * caret and selection are drawn here from the layout's geometry.
 */
export function PageView({ controller, scrollRef }: { controller: DocController; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t, language } = useI18n();
  const te = t.welddocs.editor;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const [viewport, setViewport] = useState({ top: 0, height: 800, width: 800 });
  const [composing, setComposing] = useState<string | null>(null);
  const dragging = useRef(false);

  const scale = controller.zoom * PX_PER_PT;
  const pages = controller.pages;
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = PAD_TOP;
    for (const p of pages) {
      out.push(y);
      y += p.height * scale + PAGE_GAP;
    }
    out.push(y);
    return out;
  }, [pages, scale]);
  const totalHeight = tops[tops.length - 1]! + PAD_TOP;
  const maxWidth = Math.max(...pages.map((p) => p.width)) * scale;

  // Track the viewport (scroll and size).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef]);

  const visible: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const top = tops[i]!;
    const bottom = tops[i + 1]! - PAGE_GAP;
    if (bottom >= viewport.top - OVERSCAN_PX && top <= viewport.top + viewport.height + OVERSCAN_PX) visible.push(i);
  }
  const caretPage = controller.caretPage();
  if (!visible.includes(caretPage) && pages[caretPage]) visible.push(caretPage);

  const pageLeft = (p: PageLayout) => Math.max(16, (Math.max(viewport.width, maxWidth + 32) - p.width * scale) / 2);

  // Keep the caret in view after keyboard moves and edits.
  const caret = controller.caret();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !caret || dragging.current) return;
    const page = pages[caret.page];
    if (!page) return;
    const y = tops[caret.page]! + caret.y * scale;
    const h = caret.height * scale;
    if (y < el.scrollTop + 8) el.scrollTop = y - 40;
    else if (y + h > el.scrollTop + el.clientHeight - 8) el.scrollTop = y + h - el.clientHeight + 40;
    // Wide pages (zoomed in): keep the caret horizontally visible too.
    const x = pageLeft(page) + caret.x * scale;
    if (x < el.scrollLeft + 8) el.scrollLeft = x - 40;
    else if (x > el.scrollLeft + el.clientWidth - 8) el.scrollLeft = x - el.clientWidth + 40;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.version]);

  // Typing focus follows the editor.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // A command from a menu or a dialog leaves focus nowhere once that closes: take it back, so typing goes on.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const check = () => {
      const active = document.activeElement;
      if (!active || active === document.body) inputRef.current?.focus({ preventScroll: true });
      // A menu fades out with focus still in it: wait for it to go.
      else if (active.closest('[role="menu"]') && tries++ < 60) frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [controller.version]);

  // Web fonts load late: lay out again with their real widths.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const onLoad = () => controller.fontsChanged();
    fonts.addEventListener('loadingdone', onLoad);
    void fonts.ready.then(onLoad);
    return () => fonts.removeEventListener('loadingdone', onLoad);
  }, [controller]);

  /** The page under a client point (or the nearest), with the point in page points. */
  const pageAt = useCallback(
    (clientX: number, clientY: number): { page: number; x: number; y: number } | null => {
      let best: { page: number; x: number; y: number; d: number } | null = null;
      for (const [index, el] of pageRefs.current) {
        const r = el.getBoundingClientRect();
        const d = distanceOutside(clientY, r.top, r.bottom);
        if (!best || d < best.d) {
          const ptPerPx = (pages[index]?.width ?? 1) / r.width;
          best = { page: index, x: (clientX - r.left) * ptPerPx, y: (clientY - r.top) * ptPerPx, d };
        }
      }
      return best;
    },
    [pages],
  );

  const onMouseDown = (e: React.MouseEvent, pageIndex: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    const at = pageAt(e.clientX, e.clientY);
    if (!at || at.page !== pageIndex) return;
    // Double click in an empty top or bottom margin opens the header or footer.
    if (e.detail === 2 && openHeaderOrFooter(controller, pages[pageIndex]!, pageIndex, at.y)) return;
    if ((e.metaKey || e.ctrlKey) && e.detail === 1 && openLink(controller, at)) return;
    if (e.detail === 1 && !e.shiftKey && selectImage(controller, at)) return;
    controller.clickAt(at.page, at.x, at.y, { extend: e.shiftKey, detail: e.detail });
    if (e.detail > 1) return;
    dragging.current = true;
    followDrag(controller, e, pageAt, () => scrollRef.current, () => {
      dragging.current = false;
    });
  };

  // Right click: the caret moves there (unless it is inside the selection), then the menu opens.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    const at = pageAt(e.clientX, e.clientY);
    if (at && !selectImage(controller, at) && !insideSelection(controller, at)) controller.clickAt(at.page, at.x, at.y);
    controller.openContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Text input: beforeinput carries what was typed (after IME and dead keys).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.isComposing) return;
      const action = inputAction(controller, e);
      if (!action) return;
      e.preventDefault();
      action();
    };
    const onCompositionUpdate = (e: CompositionEvent) => setComposing(e.data);
    const onCompositionEnd = (e: CompositionEvent) => {
      setComposing(null);
      if (e.data) controller.type(e.data);
      el.value = '';
    };
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('compositionupdate', onCompositionUpdate);
    el.addEventListener('compositionend', onCompositionEnd);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('compositionupdate', onCompositionUpdate);
      el.removeEventListener('compositionend', onCompositionEnd);
    };
  }, [controller]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || composing !== null) return;
    if (handleKey(controller, e)) e.preventDefault();
  };

  const onCopy = (e: React.ClipboardEvent, cut: boolean) => {
    const payload = cut ? controller.cut() : controller.copy();
    if (!payload) return;
    e.preventDefault();
    try {
      e.clipboardData.setData('text/html', payload.html);
      e.clipboardData.setData('text/plain', payload.text);
      e.clipboardData.setData(FRAGMENT_TYPE, payload.json);
    } catch {
      toast.error(te.copyFailed);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const data = e.clipboardData;
    controller.paste({ html: data.getData('text/html'), text: data.getData('text/plain'), json: data.getData(FRAGMENT_TYPE) }, pastePlain.current);
    pastePlain.current = false;
  };
  const pastePlain = useRef(false);

  // Ctrl+Shift+V pastes without formatting.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') pastePlain.current = true;
  };

  const caretPx = caret && pages[caret.page] ? { left: pageLeft(pages[caret.page]!) + caret.x * scale, top: tops[caret.page]! + caret.y * scale, height: caret.height * scale } : null;
  const rects = controller.selectionRects();
  const findMatches = controller.find?.matches ?? [];

  return (
    <div className="relative" style={{ height: totalHeight, width: Math.max(maxWidth + 32, 0) }} onKeyDownCapture={onKeyDownCapture}>
      {visible.map((index) => {
        const page = pages[index]!;
        return (
          <PageBox
            key={index}
            controller={controller}
            page={page}
            index={index}
            left={pageLeft(page)}
            top={tops[index]!}
            scale={scale}
            language={language}
            refCallback={(el) => {
              if (el) pageRefs.current.set(index, el);
              else pageRefs.current.delete(index);
            }}
            onMouseDown={(e) => onMouseDown(e, index)}
            onContextMenu={onContextMenu}
            selection={rects.filter((r) => r.page === index)}
            matches={findMatches}
            labels={{ header: te.header, footer: te.footer, resizeColumn: t.welddocs.table.resizeColumn }}
          />
        );
      })}
      {caretPx && (
        <div
          key={controller.version}
          className="pointer-events-none absolute w-px animate-[welddocs-caret_1.1s_steps(1)_infinite] bg-foreground"
          style={{ left: caretPx.left, top: caretPx.top, height: caretPx.height, display: controller.readOnly || rects.length ? 'none' : undefined }}
        />
      )}
      {composing !== null && caretPx && (
        <span className="pointer-events-none absolute whitespace-pre bg-background underline" style={{ left: caretPx.left, top: caretPx.top, fontSize: `${11 * controller.zoom}pt`, lineHeight: `${caretPx.height}px` }}>
          {composing}
        </span>
      )}
      <textarea
        ref={inputRef}
        aria-label={t.welddocs.title}
        aria-multiline
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent outline-none"
        style={{ left: caretPx?.left ?? 0, top: caretPx?.top ?? 0, width: 2, height: caretPx?.height ?? 16, opacity: composing !== null ? 0.01 : 0 }}
        onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
      />
      <style>{'@keyframes welddocs-caret { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }'}</style>
      {controller.contextMenu && <DocContextMenu controller={controller} at={controller.contextMenu} onClose={() => controller.openContextMenu(null)} />}
    </div>
  );
}

type PagePoint = { page: number; x: number; y: number };

/** How far `y` is above `top` or below `bottom` (0 between them). */
function distanceOutside(y: number, top: number, bottom: number): number {
  if (y < top) return top - y;
  if (y > bottom) return y - bottom;
  return 0;
}

/** A double click above or below the text, where there is no header or footer yet, opens one. */
function openHeaderOrFooter(controller: DocController, page: PageLayout, pageIndex: number, y: number): boolean {
  if (controller.readOnly || controller.doc.props.pageless) return false;
  const top = page.columns[0]!.y;
  const bottom = top + page.columns[0]!.height;
  if (y < top && !page.header) {
    controller.editHeader('header', pageIndex);
    return true;
  }
  if (y > bottom && !page.footer) {
    controller.editHeader('footer', pageIndex);
    return true;
  }
  return false;
}

/** Ctrl+click: follows the link under the pointer (not the caret's): to a bookmark in the document, or a safe web address. */
function openLink(controller: DocController, at: PagePoint): boolean {
  const url = controller.linkAt(at.page, at.x, at.y);
  if (!url || !isSafeLink(url)) return false;
  if (url.startsWith('#')) return controller.goToAnchor(url.slice(1));
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** A click on an image selects it (its object character). */
function selectImage(controller: DocController, at: PagePoint): boolean {
  const img = controller.imageAt(at.page, at.x, at.y);
  if (!img) return false;
  controller.setSelection({ story: img.story, anchor: img.pos, head: img.pos + 1 });
  return true;
}

/** Whether a point of a page is on the selected text. */
function insideSelection(controller: DocController, at: PagePoint): boolean {
  return controller.selectionRects().some((r) => r.page === at.page && at.x >= r.x && at.x <= r.x + r.width && at.y >= r.y && at.y <= r.y + r.height);
}

/** Scroll step while dragging near the top or bottom edge of the scroller. */
function autoScrollSpeed(y: number, r: DOMRect): number {
  if (y < r.top + 24) return -20;
  if (y > r.bottom - 24) return 20;
  return 0;
}

/** Extends the selection while the button is down, scrolling when the pointer nears an edge. */
function followDrag(
  controller: DocController,
  start: React.MouseEvent,
  pageAt: (clientX: number, clientY: number) => PagePoint | null,
  scroller: () => HTMLDivElement | null,
  onEnd: () => void,
): void {
  let scrollTimer: number | null = null;
  let last = { x: start.clientX, y: start.clientY };
  const drag = () => {
    const p = pageAt(last.x, last.y);
    if (p) controller.dragTo(p.page, p.x, p.y);
  };
  const onMove = (ev: MouseEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    drag();
    const el = scroller();
    if (!el) return;
    const speed = autoScrollSpeed(ev.clientY, el.getBoundingClientRect());
    if (speed && scrollTimer === null) {
      scrollTimer = window.setInterval(() => {
        el.scrollTop += speed;
        drag();
      }, 30);
    } else if (!speed && scrollTimer !== null) {
      window.clearInterval(scrollTimer);
      scrollTimer = null;
    }
  };
  const onUp = () => {
    onEnd();
    if (scrollTimer !== null) window.clearInterval(scrollTimer);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

/** What a `beforeinput` event does to the document; null for input the editor leaves alone. */
function inputAction(controller: DocController, e: InputEvent): (() => void) | null {
  switch (e.inputType) {
    case 'insertText':
    case 'insertReplacementText':
      return () => {
        if (e.data) controller.type(e.data);
      };
    case 'insertParagraph':
      return () => controller.enter();
    case 'insertLineBreak':
      return () => controller.lineBreak();
    case 'deleteContentBackward':
      return () => controller.backspace();
    case 'deleteContentForward':
      return () => controller.deleteForward();
    case 'historyUndo':
      return () => controller.undo();
    default:
      return e.inputType.startsWith('history') ? () => controller.redo() : null;
  }
}

function PageBox({
  controller,
  page,
  index,
  left,
  top,
  scale,
  language,
  refCallback,
  onMouseDown,
  onContextMenu,
  selection,
  matches,
  labels,
}: {
  controller: DocController;
  page: PageLayout;
  index: number;
  left: number;
  top: number;
  scale: number;
  language: string;
  refCallback: (el: HTMLDivElement | null) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  selection: { x: number; y: number; width: number; height: number }[];
  matches: { story: string; from: number; to: number }[];
  labels: { header: string; footer: string; resizeColumn: string };
}) {
  const items = useMemo(
    () => pageDisplay(controller.layout, page, { title: controller.options.title, locale: language }),
    // Pages are new objects after every layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, controller.contentVersion, language],
  );
  const matchRects = useMemo(() => {
    if (!matches.length) return [];
    const out: { x: number; y: number; width: number; height: number; current: boolean }[] = [];
    const current = controller.find?.matches[controller.find.index];
    for (const m of matches) {
      for (const r of selectionRects(controller.layout, m.story, m.from, m.to)) if (r.page === index) out.push({ ...r, current: m === current });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, page, controller.contentVersion, controller.find?.index]);

  const editingHeader = controller.inHeaderOrFooter;
  const bg = page.section.background ?? '#ffffff';
  // The selected image, if it is drawn on this page.
  const target = selectedImage(controller);
  const imageItem = target ? items.find((i) => i.kind === 'image' && i.story === target.story && i.pos === target.pos) : undefined;
  return (
    <div
      ref={refCallback}
      className="absolute cursor-text select-none shadow-[0_1px_3px_rgba(60,64,67,0.3),0_4px_8px_3px_rgba(60,64,67,0.15)]"
      style={{ left, top, width: page.width * scale, height: page.height * scale, background: bg }}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      data-page={index}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: `${page.width}pt`, height: `${page.height}pt`, transform: `scale(${scale / PX_PER_PT})` }}>
        <CommentMarks controller={controller} pageIndex={index} />
        {matchRects.map((r, i) => (
          <div key={`m${i}`} className="absolute" style={{ left: `${r.x}pt`, top: `${r.y}pt`, width: `${r.width}pt`, height: `${r.height}pt`, background: r.current ? 'rgba(255,152,0,0.55)' : 'rgba(255,214,0,0.45)' }} />
        ))}
        <div className={editingHeader ? 'opacity-50' : undefined}>
          <PageContent items={items} />
        </div>
        {editingHeader && page.header && <AreaRule y={page.header.y + page.header.height + 2} label={labels.header} />}
        {editingHeader && page.footer && <AreaRule y={page.footer.y - 4} label={labels.footer} />}
        <PeerMarks controller={controller} pageIndex={index} />
        {!imageItem &&
          selection.map((r, i) => (
            <div key={`s${i}`} className="pointer-events-none absolute" style={{ left: `${r.x}pt`, top: `${r.y}pt`, width: `${r.width}pt`, height: `${r.height}pt`, background: 'rgba(66,133,244,0.3)' }} />
          ))}
        <ColumnHandles controller={controller} pageIndex={index} ptPerPx={1 / scale} label={labels.resizeColumn} />
        {imageItem?.kind === 'image' && target && <ImageOverlay controller={controller} item={imageItem} target={target} ptPerPx={1 / scale} />}
      </div>
    </div>
  );
}

/** The text open discussions are about, highlighted (the picked one stronger). */
function CommentMarks({ controller, pageIndex }: { controller: DocController; pageIndex: number }) {
  if (!controller.showComments) return null;
  const rects: { x: number; y: number; width: number; height: number; active: boolean }[] = [];
  for (const t of controller.threads()) {
    if (t.root.resolved || t.root.suggestion || !t.at || t.at.to <= t.at.from) continue;
    const active = t.root.id === controller.activeThread;
    for (const r of selectionRects(controller.layout, t.at.story, t.at.from, t.at.to)) if (r.page === pageIndex) rects.push({ ...r, active });
  }
  return (
    <>
      {rects.map((r, i) => (
        <div key={`c${i}`} className="pointer-events-none absolute" style={{ left: `${r.x}pt`, top: `${r.y}pt`, width: `${r.width}pt`, height: `${r.height}pt`, background: r.active ? 'rgba(251,188,4,0.55)' : 'rgba(251,188,4,0.25)' }} />
      ))}
    </>
  );
}

/** How long someone's name stays on their caret after they move. */
const NAME_MS = 3000;

/** Other people's selections and carets on this page, in their colours. */
function PeerMarks({ controller, pageIndex }: { controller: DocController; pageIndex: number }) {
  const [, tick] = useState(0);
  // Re-render once names should hide.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const now = Date.now();
  return (
    <>
      {controller.peers.map((peer) => {
        const p = peer.presence;
        if (!p || !controller.doc.stories.has(p.story)) return null;
        const from = Math.min(p.anchor, p.head);
        const to = Math.max(p.anchor, p.head);
        const rects = to > from ? selectionRects(controller.layout, p.story, from, to).filter((r) => r.page === pageIndex) : [];
        const caret = caretRect(controller.layout, p.story, p.head, { page: pageIndex });
        const showName = p.typing || now - (controller.peerMovedAt(peer.clientId) ?? 0) < NAME_MS;
        return (
          <div key={peer.clientId} className="pointer-events-none">
            {rects.map((r, i) => (
              <div key={i} className="absolute opacity-25" style={{ left: `${r.x}pt`, top: `${r.y}pt`, width: `${r.width}pt`, height: `${r.height}pt`, background: peer.color }} />
            ))}
            {caret && caret.page === pageIndex && (
              <div className="absolute" style={{ left: `${caret.x}pt`, top: `${caret.y}pt`, height: `${caret.height}pt`, width: '1.5pt', background: peer.color }}>
                {showName && (
                  <span className="absolute bottom-full left-0 whitespace-nowrap rounded-sm px-1 py-px text-[7.5pt] font-medium leading-tight text-white" style={{ background: peer.color }}>
                    {peer.name}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The dashed line under a header (or over a footer) while it is being edited. */
function AreaRule({ y, label }: { y: number; label: string }) {
  return (
    <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-muted-foreground/60" style={{ top: `${y}pt` }}>
      <span className="absolute left-[72pt] top-0 rounded-b bg-muted px-1.5 text-[8pt] text-muted-foreground">{label}</span>
    </div>
  );
}
