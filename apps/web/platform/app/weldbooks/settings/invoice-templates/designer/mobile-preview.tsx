import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent } from 'react';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { renderMobileInvoice } from '@weldsuite/books-domain/invoice-template/mobile';
import type { InvoiceTemplateDocument } from '@weldsuite/books-domain/invoice-template/schema';
import 'devices.css/dist/devices.min.css';
import type { EditorAction } from './model/editor-reducer';
import { CHROME, ISLAND, MAX_SCALE, PHONE, SAFE_TOP, SCREEN, crispScale } from './model/phone';

interface MobilePreviewProps {
  doc: InvoiceTemplateDocument;
  data: InvoiceDocumentData;
  selection: string[];
  dispatch: Dispatch<EditorAction>;
}

/** CSS attribute selector for a block id, safe for any characters it holds. */
function idSelector(id: string): string {
  return `[data-block-id="${id.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
}

/**
 * Overrides for the devices.css iPhone, scoped to this preview. Its black
 * edition is Space Black, a mid grey; this one is black: near-black titanium
 * ring, buttons just light enough to show against a dark canvas, and a faint
 * sheen on the edge so the frame still reads as metal. And a screen that fits
 * its frame (see SCREEN).
 */
const PHONE_CSS = `
/* The 1px outer edge as a shadow ring, not a border: a border never shrinks below one screen pixel, so at 75% it would sit a third of a pixel off and the bezels would differ. */
.wim-phone.device-iphone-14-pro.device-black .device-frame{border:0;padding:20px;box-shadow:inset 0 0 0 1px #000,inset 0 0 3px 2px #48484c,inset 0 0 0 7px #111113}
/*
  Side buttons as black titanium: lit along the outer edge, darkening into the frame, with a
  faint highlight and shadow at the rounded ends. Sizes and offsets are multiples of 4px so,
  like the frame, they land on whole screen pixels at every scale the preview uses.
  Left: action button, volume up, volume down. Right: side button.
*/
.wim-phone.device-iphone-14-pro.device-black .device-btns,
.wim-phone.device-iphone-14-pro.device-black .device-btns::before,
.wim-phone.device-iphone-14-pro.device-black .device-btns::after,
.wim-phone.device-iphone-14-pro.device-black .device-power{
  width:4px;border-radius:2px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),inset 0 -1px 0 rgba(0,0,0,.7)
}
.wim-phone.device-iphone-14-pro.device-black .device-btns,
.wim-phone.device-iphone-14-pro.device-black .device-btns::before,
.wim-phone.device-iphone-14-pro.device-black .device-btns::after{
  background:linear-gradient(90deg,#57575c 0%,#2e2e31 45%,#141416 100%)
}
.wim-phone.device-iphone-14-pro.device-black .device-btns{left:-4px;top:116px;height:32px}
.wim-phone.device-iphone-14-pro.device-black .device-btns::before,
.wim-phone.device-iphone-14-pro.device-black .device-btns::after{left:0;height:64px}
.wim-phone.device-iphone-14-pro.device-black .device-btns::after{top:60px}
.wim-phone.device-iphone-14-pro.device-black .device-btns::before{top:140px}
.wim-phone.device-iphone-14-pro.device-black .device-power{
  right:-4px;top:200px;height:100px;
  background:linear-gradient(270deg,#57575c 0%,#2e2e31 45%,#141416 100%)
}
.wim-phone.device-iphone-14-pro .device-screen{width:${SCREEN.width}px;height:${SCREEN.height}px;border-radius:${SCREEN.radius}px}
`;

/**
 * Moves the phone by less than a pixel so its edges sit on whole screen
 * pixels. Centring puts it on a half pixel whenever the free space is odd,
 * and every vertical or horizontal edge then blurs across two pixels.
 */
function usePixelSnap(scale: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const dpr = globalThis.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      // Where it would sit without the current nudge, then the nudge to the nearest device pixel.
      const rawX = r.left - nudgeRef.current.x;
      const rawY = r.top - nudgeRef.current.y;
      const next = { x: Math.round(rawX * dpr) / dpr - rawX, y: Math.round(rawY * dpr) / dpr - rawY };
      if (Math.abs(next.x - nudgeRef.current.x) > 0.001 || Math.abs(next.y - nudgeRef.current.y) > 0.001) setNudge(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    if (el.parentElement) observer.observe(el.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [scale]);

  return { ref, nudge };
}

/**
 * The iOS status bar: the time left of the Dynamic Island, cellular signal,
 * Wi-Fi and battery right of it, each half centred in its space and level with
 * the island. 9:41 is the time Apple shows on its own product images. Glyphs
 * follow the iOS ones at their point sizes. Inline display styles, because
 * devices.css makes everything inside the phone a block.
 */
function StatusBar() {
  const side = SCREEN.width / 2 - ISLAND.width / 2;
  const middle = ISLAND.top + ISLAND.height / 2;
  // The time and icons sit 3px below the island's middle line; the bar itself stays put.
  const half = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: side, height: middle * 2, position: 'relative', top: 3 } as const;
  return (
    <div
      aria-hidden
      // No z-index: it stacks in markup order, above the content before it and below the Dynamic Island after it.
      className="pointer-events-none absolute inset-x-0 top-0 bg-white text-black"
      style={{ display: 'flex', justifyContent: 'space-between', height: SAFE_TOP, fontFamily: "-apple-system, 'SF Pro Text', 'SF Pro', system-ui, sans-serif" }}
    >
      <div style={{ ...half, paddingLeft: 10 }}>
        <span style={{ display: 'inline', fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1 }}>9:41</span>
      </div>
      <div style={{ ...half, gap: 6, paddingRight: 10 }}>
        {/* Cellular: four bars, full signal. */}
        <svg width="18" height="12" viewBox="0 0 17 11" fill="currentColor" style={{ display: 'block' }}>
          <rect x="0" y="7" width="3" height="4" rx="0.8" />
          <rect x="4.67" y="5" width="3" height="6" rx="0.8" />
          <rect x="9.33" y="2.6" width="3" height="8.4" rx="0.8" />
          <rect x="14" y="0" width="3" height="11" rx="0.8" />
        </svg>
        {/* Wi-Fi: three arcs and the dot, full signal. */}
        <svg width="16" height="12" viewBox="0 0 15 11" fill="currentColor" style={{ display: 'block' }}>
          <path d="M7.5 2.2c2.1 0 4.1.8 5.6 2.2.1.1.3.1.4 0l1.1-1.1c.1-.1.1-.3 0-.4A9.8 9.8 0 0 0 .4 2.9c-.1.1-.1.3 0 .4l1.1 1.1c.1.1.3.1.4 0a8 8 0 0 1 5.6-2.2Z" />
          <path d="M7.5 5.6c1.2 0 2.3.4 3.1 1.2.1.1.3.1.4 0l1.1-1.1c.1-.1.1-.3 0-.4a6.5 6.5 0 0 0-9.2 0c-.1.1-.1.3 0 .4l1.1 1.1c.1.1.3.1.4 0 .8-.8 1.9-1.2 3.1-1.2Z" />
          <path d="M9.6 8.4c.1-.1.1-.3 0-.4a3 3 0 0 0-4.2 0c-.1.1-.1.3 0 .4l1.9 1.9c.1.1.3.1.4 0l1.9-1.9Z" />
        </svg>
        {/* Battery: outline, charge and the terminal cap. */}
        <svg width="28" height="14" viewBox="0 0 27 13" fill="none" style={{ display: 'block' }}>
          <rect x="0.5" y="0.5" width="22" height="12" rx="3.5" stroke="currentColor" strokeOpacity="0.35" />
          <rect x="2" y="2" width="19" height="9" rx="2" fill="currentColor" />
          <path d="M24 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2Z" fill="currentColor" fillOpacity="0.4" />
        </svg>
      </div>
    </div>
  );
}

/** The phone's scale: as large as fits (up to MAX_SCALE), snapped to a crisp step. */
function usePhoneScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(MAX_SCALE);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const byHeight = (el.clientHeight - CHROME) / PHONE.height;
      const byWidth = (el.clientWidth - 48) / PHONE.width;
      setScale(crispScale(Math.min(byHeight, byWidth), globalThis.devicePixelRatio || 1));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    // Moving the window to a screen with another pixel density changes what is crisp.
    const dpr = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    dpr?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      dpr?.removeEventListener('change', update);
    };
  }, []);
  return { ref, scale };
}

/**
 * The invoice as a customer sees it on a phone: the template's mobile layout
 * on an iPhone 14 Pro from devices.css (MIT, github.com/picturepan2/devices.css). It is generated from the design, so it is edited by editing
 * the design; clicking a section selects the block it comes from.
 */
export function MobilePreview({ doc, data, selection, dispatch }: Readonly<MobilePreviewProps>) {
  const html = useMemo(() => renderMobileInvoice(doc, data, { blockIds: true }), [doc, data]);
  const { ref, scale } = usePhoneScale();
  const snap = usePixelSnap(scale);

  // Outline the selected blocks' sections; hover shows what a click would select.
  const selectionCss = useMemo(() => {
    const selected = selection.map((id) => `.wim-designer ${idSelector(id)}`).join(',');
    const selectedCss = selected ? `${selected}{outline:2px solid var(--primary)}` : '';
    // devices.css sets every element inside the phone to display:block; style tags must stay hidden.
    // A phone shows no scrollbar track.
    return `.wim-designer style{display:none}
.wim-designer{scrollbar-width:none}
.wim-designer::-webkit-scrollbar{display:none}
.wim-designer [data-block-id]{cursor:pointer;border-radius:4px;outline-offset:3px}
.wim-designer [data-block-id]:hover{outline:1px solid color-mix(in oklab, var(--primary) 60%, transparent)}
${selectedCss}`;
  }, [selection]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-block-id]');
    const id = target?.dataset.blockId;
    if (!id) {
      dispatch({ type: 'select', ids: [] });
      return;
    }
    dispatch({ type: 'select', ids: [id], mode: e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace' });
  };

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-auto bg-muted/70 px-6 py-8 dark:bg-muted/30">
      {/*
        Centred both ways (auto margins never push it out of reach when it overflows).
        `zoom`, not a transform: the phone is laid out and painted at its final size,
        so text, borders and the frame's thin rings stay sharp instead of being resampled.
      */}
      <div ref={snap.ref} className="relative m-auto shrink-0" style={{ left: snap.nudge.x, top: snap.nudge.y }}>
        <div style={{ zoom: scale, width: PHONE.width, height: PHONE.height }}>
          <style>{PHONE_CSS}</style>
          <div className="wim-phone device device-iphone-14-pro device-black">
            <div className="device-frame">
              <div className="device-screen overflow-hidden">
                <div
                  role="presentation"
                  className="wim-designer h-full overflow-y-auto overscroll-contain bg-white"
                  // Clipped to the screen's own corners: a scrolling area can otherwise show square corner pixels.
                  style={{ paddingTop: SAFE_TOP, borderRadius: SCREEN.radius, clipPath: `inset(0 round ${SCREEN.radius}px)` }}
                  onClick={onClick}
                  data-testid="mobile-preview"
                >
                  <style>{selectionCss}</style>
                  <div dangerouslySetInnerHTML={{ __html: html }} />
                </div>
                {/* After the content (which stacks like a positioned box because of its clip-path), before the island. */}
                <StatusBar />
              </div>
            </div>
            <div className="device-stripe" />
            <div className="device-header" />
            <div className="device-sensors" />
            <div className="device-btns" />
            <div className="device-power" />
            <div className="device-home" />
          </div>
        </div>
      </div>
    </div>
  );
}
