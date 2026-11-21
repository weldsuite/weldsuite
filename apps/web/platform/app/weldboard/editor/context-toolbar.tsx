import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowLeftRight,
  Bold,
  Group,
  Highlighter,
  Italic,
  Link2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Presentation,
  Strikethrough,
  TextCursorInput,
  Underline,
  Ungroup,
} from 'lucide-react';
import {
  alignOps,
  DEFAULT_STROKE,
  DEFAULT_TEXT,
  distributeOps,
  keyAllowed,
  makeSticky,
  stickyHeightFor,
  newId,
  groupOps,
  PALETTE,
  SHAPE_FILLS,
  STICKY_COLORS,
  stackOps,
  ungroupOps,
  type BoardElement,
  type Cap,
  type ConnectorRoute,
  type Op,
  type Point,
  type ShapeKind,
} from '@weldsuite/board-engine';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { formatShortcut, isMacPlatform } from '@weldsuite/ui/lib/shortcut';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { toBoard, toScreen } from './model/camera';
import { duplicateSelection } from './model/clipboard';
import { copyToClipboard, cutToClipboard, pasteFromClipboard } from './clipboard-actions';
import { handlePositions } from './model/interactions';
import { copyStyle, pasteStyle } from './model/style';
import { hasMark, setMark, toggleMark } from './model/text-editing';
import { BASIC_SHAPES, FLOW_SHAPES, ShapeGrid, ShapeIcon } from './toolbar';
import { Swatches } from './swatches';
import { BarButton, BarPopover, Divider } from './ui';

export interface ContextActions {
  onLink: () => void;
  /** Opens a link (an element's own). */
  onOpenLink?: (url: string) => void;
  onComment?: (elementId: string) => void;
  onToTasks?: (ids: string[]) => void;
  onCopyLink?: (id: string) => void;
  onPresentFrom?: (frameId: string) => void;
  onOpenRecord?: (el: BoardElement) => void;
  onExportSelection?: () => void;
  onRenameFrame?: (id: string) => void;
  onAltText?: (id: string) => void;
  onCrop?: (id: string) => void;
}

const FONT_SIZES: { label: string; size: number | null }[] = [
  { label: 'S', size: 14 },
  { label: 'M', size: 20 },
  { label: 'L', size: 32 },
  { label: 'XL', size: 48 },
];

function setAll(c: BoardController, els: BoardElement[], patch: Record<string, unknown>): void {
  const ops: Op[] = [];
  for (const el of els) {
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (keyAllowed(el.type, k)) p[k] = v;
    if (Object.keys(p).length) ops.push({ type: 'set', id: el.id, patch: p });
  }
  c.apply({ type: 'batch', ops });
}

/** Whether every element with text has `mark` on all of it. */
function allMarked(els: BoardElement[], mark: 'b' | 'i' | 'u' | 's'): boolean {
  const texty = els.filter((e) => e.text?.text);
  return texty.length > 0 && texty.every((e) => e.text!.marks.length > 0 && e.text!.marks.every(([, m]) => !!m[mark]));
}

/** Bold and friends on whole elements (no text being edited). */
function markAll(c: BoardController, els: BoardElement[], mark: 'b' | 'i' | 'u' | 's'): void {
  const texty = els.filter((e) => e.text?.text);
  const all = allMarked(els, mark);
  c.apply({ type: 'batch', ops: texty.map((e) => ({ type: 'formatText' as const, id: e.id, at: 0, runs: [[e.text!.text.length, { [mark]: all ? null : true }]] as [number, Record<string, true | null>][] })) });
}

/** A value the selection shares, or `mixed` when its elements differ. */
function shared<T>(els: BoardElement[], get: (el: BoardElement) => T): { value: T | undefined; mixed: boolean } {
  const first = get(els[0]!);
  const mixed = els.some((e) => get(e) !== first);
  return { value: mixed ? undefined : first, mixed };
}

/** Several colours at once: the swatch of a selection whose colours differ. */
const MIXED_SWATCH = 'bg-[conic-gradient(#f87171,#facc15,#4ade80,#60a5fa,#c084fc,#f87171)]';

/** The fill button's swatch: the fill colour, a red slash for none, or several colours when mixed. */
function fillSwatch(fill: BoardElement['fill'], mixed = false) {
  if (mixed) return <span className={cn('size-5 rounded-sm border shadow-sm', MIXED_SWATCH)} />;
  return (
    <span
      className={cn('size-5 rounded-sm border shadow-sm', !fill || fill === 'transparent' ? 'bg-[linear-gradient(135deg,transparent_45%,#ef4444_45%,#ef4444_55%,transparent_55%)]' : '')}
      style={{ backgroundColor: fill !== 'transparent' ? fill : undefined }}
    />
  );
}

/** Light fills for shapes, cards and frames: "none" and fifteen tints, two even rows. */
const LIGHT_FILLS = ['transparent', ...SHAPE_FILLS, '#ecfccb', '#ccfbf1', '#e0e7ff', '#fae8ff', '#e5e7eb'];
/** Strong fills: the palette with a mid grey for its white (white is a light fill already). */
const STRONG_FILLS = PALETTE.map((color) => (color === '#ffffff' ? '#9ca3af' : color));
/** Line colours: "none" and the palette but white (a white line on the board is lost). */
const LINE_COLORS = ['transparent', ...PALETTE.filter((color) => color !== '#ffffff')];

/** The floating bar's height: a 32px button, 4px padding each side and a 1px border each side. */
const BAR_HEIGHT = 42;

/**
 * Whether the bar, at `top` (canvas pixels) and centred on `left`, would
 * cover something on the board other than the selection: a neighbouring
 * sticky, the node next to it. Frames, lines and drawings don't count.
 */
function coversOthers(c: BoardController, left: number, top: number, width: number): boolean {
  const a = toBoard(c.camera, { x: left - width / 2, y: top });
  const b = toBoard(c.camera, { x: left + width / 2, y: top + BAR_HEIGHT });
  const area = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  const selected = c.selection;
  // The index answers with everything in the cells around the area: each one is checked against it.
  for (const id of c.index.query(area)) {
    if (selected.has(id)) continue;
    const el = c.board.get(id);
    if (!el || el.type === 'frame' || el.type === 'connector' || el.type === 'pen' || el.type === 'group' || el.type === 'comment') continue;
    const r = c.boundsOf(el);
    if (r.x < area.x + area.w && area.x < r.x + r.w && r.y < area.y + area.h && area.y < r.y + r.h) return true;
  }
  return false;
}

/** Where the bar's centre goes: over the selection, but with the whole bar inside the canvas. */
function barCenter(x: number, barWidth: number, viewportWidth: number): number {
  const half = barWidth / 2 + 8;
  if (viewportWidth <= half * 2) return viewportWidth / 2;
  return Math.max(half, Math.min(viewportWidth - half, x));
}

/** A bar's own width, measured as it changes, and the ref that measures it. */
function useBarWidth(): [number, (el: HTMLDivElement | null) => void] {
  const [barWidth, setBarWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const barRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    setBarWidth(el.offsetWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBarWidth(el.offsetWidth));
    observer.observe(el);
    observerRef.current = observer;
  }, []);
  return [barWidth, barRef];
}

/** Where the bar goes (canvas pixels): above the selection, unless it would hide a neighbour there and below is clear. */
function barPlacement(c: BoardController, box: { x: number; y: number; w: number; h: number }, barWidth: number): { left: number; top: number } {
  const top = toScreen(c.camera, { x: box.x + box.w / 2, y: box.y });
  const bottom = toScreen(c.camera, { x: box.x + box.w / 2, y: box.y + box.h });
  // Clear of the handles when they show: the rotate handle sits 34px above the box, a connect handle 18px out.
  const gap = handlePositions(c).length ? 48 : 16;
  const left = barCenter(top.x, barWidth, c.viewport.width);
  const aboveTop = top.y - gap - BAR_HEIGHT;
  const belowTop = Math.min(c.viewport.height - 56, bottom.y + gap);
  if (aboveTop <= 16) return { left, top: belowTop };
  if (!coversOthers(c, left, aboveTop, barWidth)) return { left, top: aboveTop };
  const belowClear = belowTop + BAR_HEIGHT < c.viewport.height && !coversOthers(c, left, belowTop, barWidth);
  return { left, top: belowClear ? belowTop : aboveTop };
}

const BAR_CLASS = 'pointer-events-auto absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-background p-1 shadow-lg';

export function ContextToolbar({ controller: c, actions }: { controller: BoardController; actions: ContextActions }) {
  const { t } = useI18n();
  // The bar's own width, so an element near the edge doesn't push half of it off the canvas.
  const [barWidth, barRef] = useBarWidth();
  const te = t.weldboard.editor;
  const ta = te.actions;
  const els = c.selected;
  const box = c.selectionRect();
  if (!els.length || !box || c.readOnly) return null;
  if (c.transient.marquee || c.transient.guides) return null;

  const style = barPlacement(c, box, barWidth);
  const locked = els.every((e) => e.locked);
  const lockButton = (
    <BarButton label={locked ? ta.unlock : ta.lock} keys={['mod', 'L']} onClick={() => setAll(c, els, { locked: !locked })}>
      {locked ? <LockOpen /> : <Lock />}
    </BarButton>
  );

  if (locked) {
    return (
      <div ref={barRef} className={BAR_CLASS} style={style}>
        {lockButton}
      </div>
    );
  }

  return (
    <div ref={barRef} className={BAR_CLASS} style={style} role="toolbar" aria-label={te.selectionToolbar} onPointerDown={(e) => e.stopPropagation()}>
      {c.editing ? <EditingTextControls c={c} actions={actions} /> : <SelectionControls c={c} els={els} actions={actions} lockButton={lockButton} />}
    </div>
  );
}

/** The bar while text is being edited: marks, colours and a link on the selected words. */
function EditingTextControls({ c, actions }: { c: BoardController; actions: ContextActions }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  return (
    <>
      <BarButton label={ts.bold} keys={['mod', 'B']} active={hasMark(c, 'b')} onClick={() => toggleMark(c, 'b')}>
        <Bold />
      </BarButton>
      <BarButton label={ts.italic} keys={['mod', 'I']} active={hasMark(c, 'i')} onClick={() => toggleMark(c, 'i')}>
        <Italic />
      </BarButton>
      <BarButton label={ts.underline} keys={['mod', 'U']} active={hasMark(c, 'u')} onClick={() => toggleMark(c, 'u')}>
        <Underline />
      </BarButton>
      <BarButton label={ts.strike} keys={['mod', 'shift', 'S']} active={hasMark(c, 's')} onClick={() => toggleMark(c, 's')}>
        <Strikethrough />
      </BarButton>
      <BarPopover label={ts.textColor} trigger={<span className="text-sm font-semibold underline decoration-2">A</span>}>
        <Swatches colors={PALETTE} value={undefined} onPick={(color) => setMark(c, 'c', color)} />
      </BarPopover>
      <BarPopover label={ts.highlight} trigger={<Highlighter />}>
        <Swatches colors={[null, '#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#ddd6fe', '#e5e7eb']} noneLabel={ts.noHighlight} value={undefined} onPick={(color) => setMark(c, 'h', color)} />
      </BarPopover>
      <BarButton label={ts.link} keys={['mod', 'K']} onClick={actions.onLink}>
        <Link2 />
      </BarButton>
    </>
  );
}

/** The bar for selected elements: what fits their kind, then link, lock and the ⋯ menu. */
function SelectionControls({ c, els, actions, lockButton }: { c: BoardController; els: BoardElement[]; actions: ContextActions; lockButton: ReactNode }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const ta = t.weldboard.editor.actions;
  const types = new Set(els.map((e) => e.type));
  const only = types.size === 1 ? els[0]!.type : null;
  const single = els.length === 1 ? els[0]! : null;
  const hasText = only !== 'connector' && els.some((e) => keyAllowed(e.type, 'text'));
  const fillable = only === 'shape' || only === 'card' || only === 'frame' || only === 'text';
  return (
    <>
      {only === 'sticky' && <StickyControls c={c} els={els} />}
      {fillable && <FillControl c={c} els={els} />}
      {only === 'shape' && (
        <>
          <ShapeControl c={c} els={els} />
          <StrokeControls c={c} els={els} />
        </>
      )}
      {only === 'connector' && <ConnectorControls c={c} els={els} />}
      {only === 'pen' && <StrokeControls c={c} els={els} />}
      {only === 'card' && <AccentControl c={c} els={els} />}
      {hasText && only !== 'sticky' && <FontSize c={c} els={els} />}
      {hasText && <TextControls c={c} els={els} />}
      {only === 'frame' && single && <FrameControls c={c} frame={single} actions={actions} />}
      {els.length > 1 && <ArrangeControls c={c} count={els.length} />}
      {only === 'group' && single && (
        <BarButton label={ta.ungroup} keys={['mod', 'shift', 'G']} onClick={() => c.apply(ungroupOps(c.board, single.id), { select: c.board.childIds(single.id) })}>
          <Ungroup />
        </BarButton>
      )}
      <Divider />
      <BarButton label={ts.link} keys={['mod', 'K']} active={!!single?.link} onClick={actions.onLink}>
        <Link2 />
      </BarButton>
      {lockButton}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={ta.more} className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent [&_svg]:size-4" onMouseDown={(e) => e.preventDefault()}>
            <MoreHorizontal />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
          <SelectionMenuItems c={c} actions={actions} />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Sticky colour and text size. */
function StickyControls({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const fill = shared(els, (e) => e.fill);
  return (
    <>
      <BarPopover label={fill.mixed ? `${ts.stickyColor}: ${ts.mixed}` : ts.stickyColor} trigger={fill.mixed ? fillSwatch(undefined, true) : <span className="size-5 rounded-sm border shadow-sm" style={{ backgroundColor: fill.value }} />}>
        <Swatches colors={STICKY_COLORS} value={fill.value} onPick={(color) => color && setAll(c, els, { fill: color })} />
      </BarPopover>
      <FontSize c={c} els={els} auto />
    </>
  );
}

/** Fill for shapes, cards, frames and text: light tints, then strong colours. */
function FillControl({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const fill = shared(els, (e) => e.fill);
  return (
    <BarPopover label={fill.mixed ? `${ts.fill}: ${ts.mixed}` : ts.fill} trigger={fillSwatch(fill.value, fill.mixed)}>
      <div className="flex flex-col gap-2">
        <Swatches colors={LIGHT_FILLS} custom={false} noneLabel={ts.noFill} value={fill.value} onPick={(color) => color && setAll(c, els, { fill: color })} />
        <Swatches colors={STRONG_FILLS} value={fill.value} onPick={(color) => color && setAll(c, els, { fill: color })} />
      </div>
    </BarPopover>
  );
}

/** Swap the shape: the same shapes as the toolbar's picker, the current one marked. */
function ShapeControl({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  const shape = shared(els, (e) => e.shape).value;
  const pick = (kind: ShapeKind) => setAll(c, els, { shape: kind });
  return (
    <BarPopover label={te.style.shape} trigger={<ShapeIcon kind={shape ?? 'rectangle'} />}>
      <div className="flex w-72 flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">{te.shapes.basic}</p>
        <ShapeGrid items={BASIC_SHAPES.map((kind) => [kind, te.shapes[kind]])} value={shape} onPick={pick} />
        <p className="text-xs font-medium text-muted-foreground">{te.shapes.flowchart}</p>
        {/* A kind that is also a basic shape is marked there only. */}
        <ShapeGrid items={FLOW_SHAPES.map(([kind, name]) => [kind, te.shapes[name]])} value={shape && !BASIC_SHAPES.includes(shape) ? shape : undefined} onPick={pick} />
      </div>
    </BarPopover>
  );
}

/** A card's accent: the coloured edge on its left. */
function AccentControl({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const accent = els[0]!.stroke;
  return (
    <BarPopover
      label={t.weldboard.editor.style.accentColor}
      // A card with its coloured edge, so it reads apart from the fill swatch beside it.
      trigger={
        <span className="flex size-5 overflow-hidden rounded-sm border bg-background shadow-sm">
          <span className="w-1.5" style={{ backgroundColor: accent ?? '#3b82f6' }} />
        </span>
      }
    >
      <Swatches colors={PALETTE} value={accent} onPick={(color) => color && setAll(c, els, { stroke: color })} />
    </BarPopover>
  );
}

/** Text colour, bold and alignment for the text of whole elements. */
function TextControls({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const textColor = shared(els, (e) => e.textColor);
  // Text without a colour of its own has the default one: that swatch is marked.
  const current = textColor.mixed ? undefined : (textColor.value ?? DEFAULT_TEXT);
  return (
    <>
      <BarPopover
        label={textColor.mixed ? `${ts.textColor}: ${ts.mixed}` : ts.textColor}
        trigger={<span className={cn('text-sm font-semibold underline decoration-2', textColor.mixed && 'decoration-dotted')} style={{ textDecorationColor: current ?? DEFAULT_TEXT }}>A</span>}
      >
        <Swatches colors={PALETTE} value={current} onPick={(color) => color && setAll(c, els, { textColor: color })} />
      </BarPopover>
      <BarButton label={ts.bold} keys={['mod', 'B']} active={allMarked(els, 'b')} onClick={() => markAll(c, els, 'b')}>
        <Bold />
      </BarButton>
      <AlignControl c={c} els={els} />
    </>
  );
}

/** A frame's name and its place in the presentation. */
function FrameControls({ c, frame, actions }: { c: BoardController; frame: BoardElement; actions: ContextActions }) {
  const { t } = useI18n();
  const ta = t.weldboard.editor.actions;
  const inSlides = frame.slide !== undefined;
  const toggleSlide = () => {
    const max = Math.max(-1, ...[...c.board.elements.values()].filter((e) => e.type === 'frame' && e.slide !== undefined).map((e) => e.slide!));
    setAll(c, [frame], { slide: inSlides ? null : max + 1 });
  };
  return (
    <>
      <BarButton label={ta.renameFrame} onClick={() => actions.onRenameFrame?.(frame.id)}>
        <TextCursorInput />
      </BarButton>
      <BarButton label={inSlides ? ta.removeFromSlides : ta.addToSlides} active={inSlides} onClick={toggleSlide}>
        <Presentation />
      </BarButton>
    </>
  );
}

/** Arrange and group several elements. */
function ArrangeControls({ c, count }: { c: BoardController; count: number }) {
  const { t } = useI18n();
  const ta = t.weldboard.editor.actions;
  const across = [
    ['left', ta.alignLeft, AlignStartVertical],
    ['center', ta.alignCenter, AlignCenterVertical],
    ['right', ta.alignRight, AlignEndVertical],
  ] as const;
  const down = [
    ['top', ta.alignTop, AlignStartHorizontal],
    ['middle', ta.alignMiddle, AlignCenterHorizontal],
    ['bottom', ta.alignBottom, AlignEndHorizontal],
  ] as const;
  const group = () => {
    const id = newId('g');
    c.apply(groupOps(c.board, [...c.selection], id), { select: [id] });
  };
  return (
    <>
      <Divider />
      {/* Icon buttons in three groups: align across, align down, spread out. */}
      <BarPopover label={ta.arrange} trigger={<AlignHorizontalJustifyCenter />}>
        <div className="flex items-center gap-0.5">
          {across.map(([mode, label, Icon]) => (
            <BarButton key={mode} label={label} onClick={() => c.apply(alignOps(c.board, c.selection, mode))}>
              <Icon />
            </BarButton>
          ))}
          <Divider />
          {down.map(([mode, label, Icon]) => (
            <BarButton key={mode} label={label} onClick={() => c.apply(alignOps(c.board, c.selection, mode))}>
              <Icon />
            </BarButton>
          ))}
          <Divider />
          <BarButton label={ta.distributeH} disabled={count < 3} onClick={() => c.apply(distributeOps(c.board, c.selection, 'x'))}>
            <AlignHorizontalDistributeCenter />
          </BarButton>
          <BarButton label={ta.distributeV} disabled={count < 3} onClick={() => c.apply(distributeOps(c.board, c.selection, 'y'))}>
            <AlignVerticalDistributeCenter />
          </BarButton>
        </div>
      </BarPopover>
      <BarButton label={ta.group} keys={['mod', 'G']} onClick={group}>
        <Group />
      </BarButton>
    </>
  );
}

/** The selection's actions: the toolbar's ⋯ menu and the right-click menu. */
function SelectionMenuItems({ c, actions }: { c: BoardController; actions: ContextActions }) {
  const { t } = useI18n();
  const ta = t.weldboard.editor.actions;
  const els = c.selected;
  const single = els.length === 1 ? els[0]! : null;
  const keys = (shortcut: string[]) => <DropdownMenuShortcut>{formatShortcut(shortcut)}</DropdownMenuShortcut>;
  const blocked = () => toast.info(ta.clipboardBlocked.replace('{keys}', formatShortcut(['mod', 'V'])));
  const groupable = els.length > 1;
  return (
    <>
      {single?.link && actions.onOpenLink && (
        <>
          <DropdownMenuItem onSelect={() => actions.onOpenLink!(single.link!)}>
            {t.weldboard.editor.style.openLink}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onSelect={() => void cutToClipboard(c).then((ok) => ok || toast.error(ta.clipboardFailed))}>
        {ta.cut}
        {keys(['mod', 'X'])}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void copyToClipboard(c).then((ok) => ok || toast.error(ta.clipboardFailed))}>
        {ta.copy}
        {keys(['mod', 'C'])}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void pasteFromClipboard(c, pasteSpot(c)).then((ok) => ok || blocked())}>
        {ta.paste}
        {keys(['mod', 'V'])}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => duplicateSelection(c)}>
        {ta.duplicate}
        {keys(['mod', 'D'])}
      </DropdownMenuItem>
      {groupable && (
        <DropdownMenuItem
          onSelect={() => {
            const id = newId('g');
            c.apply(groupOps(c.board, [...c.selection], id), { select: [id] });
          }}
        >
          {ta.group}
          {keys(['mod', 'G'])}
        </DropdownMenuItem>
      )}
      {single?.type === 'group' && (
        <DropdownMenuItem onSelect={() => c.apply(ungroupOps(c.board, single.id), { select: c.board.childIds(single.id) })}>
          {ta.ungroup}
          {keys(['mod', 'shift', 'G'])}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => setAll(c, els, { locked: true })}>
        {ta.lock}
        {keys(['mod', 'L'])}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'front'))}>
        {ta.bringFront}
        {keys(['mod', ']'])}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'forward'))}>
        {ta.bringForward}
        {keys([']'])}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'backward'))}>
        {ta.sendBackward}
        {keys(['['])}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'back'))}>
        {ta.sendBack}
        {keys(['mod', '['])}
      </DropdownMenuItem>
      {single && actions.onCopyLink && <DropdownMenuItem onSelect={() => actions.onCopyLink!(single.id)}>{ta.copyLink}</DropdownMenuItem>}
      {single && actions.onComment && <DropdownMenuItem onSelect={() => actions.onComment!(single.id)}>{ta.addComment}</DropdownMenuItem>}
      {actions.onToTasks && els.some((e) => e.type === 'sticky' || e.type === 'card' || e.type === 'shape') && (
        <DropdownMenuItem onSelect={() => actions.onToTasks!(els.filter((e) => e.type === 'sticky' || e.type === 'card' || e.type === 'shape').map((e) => e.id))}>{ta.toTask}</DropdownMenuItem>
      )}
      {single?.type === 'frame' && actions.onPresentFrom && <DropdownMenuItem onSelect={() => actions.onPresentFrom!(single.id)}>{ta.presentFromHere}</DropdownMenuItem>}
      {single?.type === 'record' && actions.onOpenRecord && <DropdownMenuItem onSelect={() => actions.onOpenRecord!(single)}>{ta.openRecord}</DropdownMenuItem>}
      {single?.type === 'image' && actions.onAltText && <DropdownMenuItem onSelect={() => actions.onAltText!(single.id)}>{ta.altText}</DropdownMenuItem>}
      {single?.type === 'image' && actions.onCrop && !single.locked && <DropdownMenuItem onSelect={() => actions.onCrop!(single.id)}>{ta.crop}</DropdownMenuItem>}
      {single?.type === 'image' && single.crop && <DropdownMenuItem onSelect={() => setAll(c, [single], { crop: null })}>{ta.resetCrop}</DropdownMenuItem>}
      <DropdownMenuItem onSelect={() => copyStyle(c)}>
        {ta.copyStyle}
        {keys(['mod', 'alt', 'C'])}
      </DropdownMenuItem>
      {c.copiedStyle && (
        <DropdownMenuItem onSelect={() => pasteStyle(c)}>
          {ta.pasteStyle}
          {keys(['mod', 'alt', 'P'])}
        </DropdownMenuItem>
      )}
      {single && single.type !== 'connector' && single.type !== 'pen' && (
        <DropdownMenuItem onSelect={() => setAll(c, [single], { rotation: (((single.rotation ?? 0) + Math.PI / 2 + Math.PI) % (Math.PI * 2)) - Math.PI })}>{ta.rotate}</DropdownMenuItem>
      )}
      {actions.onExportSelection && <DropdownMenuItem onSelect={actions.onExportSelection}>{ta.exportSelection}</DropdownMenuItem>}
      <DropdownMenuSeparator />
      {/* No icon, like the items above it: red and set apart is enough. */}
      <DropdownMenuItem variant="destructive" onSelect={() => c.deleteSelection()}>
        {ta.delete}
        <DropdownMenuShortcut>{isMacPlatform() ? '⌫' : 'Del'}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  );
}

/**
 * Right-click on the selection: the same actions as the toolbar's ⋯ menu, opened
 * where the pointer is (`at`, canvas pixels). A locked selection offers Unlock.
 */
export function SelectionContextMenu({ controller: c, actions, at, onClose }: {
  controller: BoardController;
  actions: ContextActions;
  at: Point | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ta = t.weldboard.editor.actions;
  const els = c.selected;
  const shown = !!at && els.length > 0 && !c.readOnly;
  // The selection went away while the menu was open (deleted, or by a collaborator).
  useEffect(() => {
    if (at && !shown) onClose();
  }, [at, shown, onClose]);
  if (!shown) return null;
  const locked = els.every((e) => e.locked);
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: at.x, top: at.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        {locked ? (
          <DropdownMenuItem onSelect={() => setAll(c, els, { locked: false })}>
            <LockOpen />
            {ta.unlock}
          </DropdownMenuItem>
        ) : (
          <SelectionMenuItems c={c} actions={actions} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Where Paste puts things from a menu: just right of and below the selection, else the middle of the view. */
function pasteSpot(c: BoardController): Point {
  const r = c.selectionRect();
  return r ? { x: r.x + r.w / 2 + 24, y: r.y + r.h / 2 + 24 } : c.center();
}

/**
 * Right-click on empty board: paste, select all, a sticky note there, and
 * fitting the board in view. `at` is in canvas pixels.
 */
export function CanvasContextMenu({ controller: c, at, onClose }: { controller: BoardController; at: Point | null; onClose: () => void }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  if (!at || c.readOnly) return null;
  const where = toBoard(c.camera, at);
  const keys = (shortcut: string[]) => <DropdownMenuShortcut>{formatShortcut(shortcut)}</DropdownMenuShortcut>;
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none absolute size-0" style={{ left: at.x, top: at.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem
          onSelect={() =>
            void pasteFromClipboard(c, where).then((ok) => ok || toast.info(te.actions.clipboardBlocked.replace('{keys}', formatShortcut(['mod', 'V']))))
          }
        >
          {te.actions.paste}
          {keys(['mod', 'V'])}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => c.selectAll()}>
          {te.actions.selectAll}
          {keys(['mod', 'A'])}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => addStickyAt(c, where)}>
          {te.actions.addStickyHere}
          <DropdownMenuShortcut>N</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => c.zoomToFit()}>
          {te.zoom.fit}
          {keys(['shift', '1'])}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A sticky note in the sticky tool's colour, centred on `at`, ready to type in. */
function addStickyAt(c: BoardController, at: Point): void {
  const el = makeSticky(at.x - 100, at.y - 100, { after: c.board.topOrder(null), createdBy: c.options.userId, now: Date.now() }, { color: c.toolOptions.stickyColor });
  c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
  c.startEditing(el.id, 0);
}

function FontSize({ c, els, auto }: { c: BoardController; els: BoardElement[]; auto?: boolean }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const size = shared(els, (e) => (auto && e.autoFit ? 'auto' : (e.fontSize ?? 16)));
  /**
   * A chosen size on stickies: the sticky grows taller when its text needs more
   * room at that size (a sticky shrinks its text to fit, so a bigger size alone
   * would change nothing).
   */
  const pick = (fontSize: number) => {
    const ops: Op[] = els.map((el) => {
      const patch: Record<string, unknown> = { fontSize, autoFit: false };
      if (el.type === 'sticky') {
        const h = stickyHeightFor(el, fontSize, { measurer: c.measurer, showAuthors: c.showAuthors });
        if (h > el.h) patch.h = h;
      }
      return { type: 'set', id: el.id, patch: Object.fromEntries(Object.entries(patch).filter(([k]) => keyAllowed(el.type, k))) };
    });
    c.apply({ type: 'batch', ops });
  };
  const option = (on: boolean) => cn('rounded-md px-3 py-1 text-left text-sm hover:bg-accent', on && 'bg-accent font-medium');
  let shown: string | number = size.value === 'auto' ? ts.autoSize : (size.value ?? 16);
  if (size.mixed) shown = '–';
  return (
    <BarPopover label={size.mixed ? `${ts.fontSize}: ${ts.mixed}` : ts.fontSize} trigger={<span className="min-w-6 text-xs font-medium tabular-nums">{shown}</span>}>
      <div className="flex flex-col gap-1" role="group" aria-label={ts.fontSize}>
        {auto && (
          <button type="button" aria-pressed={size.value === 'auto'} className={option(size.value === 'auto')} onClick={() => setAll(c, els, { autoFit: true, fontSize: 22 })}>
            {ts.autoSize}
          </button>
        )}
        {FONT_SIZES.map((f) => (
          <button key={f.label} type="button" aria-pressed={size.value === f.size} className={option(size.value === f.size)} onClick={() => pick(f.size!)}>
            {f.label} · {f.size}
          </button>
        ))}
        <div className="flex gap-1 pt-1">
          {[10, 12, 16, 24, 40, 64, 96].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={size.value === n}
              className={cn('rounded px-1.5 py-0.5 text-xs tabular-nums hover:bg-accent', size.value === n && 'bg-accent font-medium')}
              onClick={() => pick(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </BarPopover>
  );
}

/** The alignment the align button moves to on a click, and its icon for the current one. */
function alignStep(align: string): { next: 'left' | 'center' | 'right'; Icon: typeof AlignLeft } {
  if (align === 'left') return { next: 'center', Icon: AlignLeft };
  if (align === 'center') return { next: 'right', Icon: AlignCenter };
  return { next: 'left', Icon: AlignRight };
}

function AlignControl({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const align = els[0]!.textAlign ?? (els[0]!.type === 'text' ? 'left' : 'center');
  const { next, Icon } = alignStep(align);
  const names = { left: ts.alignLeft, center: ts.alignCenter, right: ts.alignRight } as Record<string, string>;
  // Says what it is now; a click moves on to the next one.
  return (
    <BarButton label={`${ts.align}: ${names[align] ?? align}`} onClick={() => setAll(c, els, { textAlign: next })}>
      <Icon />
    </BarButton>
  );
}

function StrokeControls({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const el = els[0]!;
  // A line's colour is its line; a shape's is its border.
  const isLine = el.type === 'connector' || el.type === 'pen';
  const stroke = shared(els, (e) => e.stroke ?? DEFAULT_STROKE);
  const width = shared(els, (e) => e.strokeWidth ?? 2);
  const style = shared(els, (e) => e.strokeStyle ?? 'solid');
  const label = isLine ? ts.lineColor : ts.stroke;
  return (
    <BarPopover
      label={stroke.mixed ? `${label}: ${ts.mixed}` : label}
      trigger={stroke.mixed ? fillSwatch(undefined, true) : <span className="size-5 rounded-sm border-[3px]" style={{ borderColor: stroke.value }} />}
    >
      <div className="flex w-64 flex-col gap-2">
        <Swatches colors={el.type === 'pen' ? PALETTE : LINE_COLORS} noneLabel={ts.noStroke} value={stroke.value} onPick={(color) => color && setAll(c, els, { stroke: color })} />
        <div className="flex items-center gap-1" role="group" aria-label={ts.strokeWidth}>
          <span className="w-20 text-xs text-muted-foreground">{ts.strokeWidth}</span>
          {[1, 2, 4, 6, 10].map((w) => (
            <button
              key={w}
              type="button"
              aria-label={`${w} px`}
              title={`${ts.strokeWidth}: ${w} px`}
              aria-pressed={width.value === w}
              className={cn('flex size-8 items-center justify-center rounded-md hover:bg-accent', width.value === w && 'bg-accent')}
              onClick={() => setAll(c, els, { strokeWidth: w })}
            >
              <span className="w-5 rounded-full bg-foreground" style={{ height: Math.max(1, w / 1.5) }} />
            </button>
          ))}
        </div>
        {el.type !== 'pen' && (
          <div className="flex items-center gap-1" role="group" aria-label={ts.strokeStyle}>
            <span className="w-20 text-xs text-muted-foreground">{ts.strokeStyle}</span>
            {(['solid', 'dashed', 'dotted'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={style.value === s}
                className={cn('rounded-md px-2 py-1 text-xs hover:bg-accent', style.value === s && 'bg-accent')}
                onClick={() => setAll(c, els, { strokeStyle: s === 'solid' ? null : s })}
              >
                {ts[s]}
              </button>
            ))}
          </div>
        )}
      </div>
    </BarPopover>
  );
}

function ConnectorControls({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.connector;
  const el = els[0]!;
  const caps: Cap[] = ['none', 'arrow', 'triangle', 'circle', 'diamond', 'bar'];
  const routes: ConnectorRoute[] = ['straight', 'elbow', 'curved'];
  return (
    <>
      <BarPopover label={tc.route} trigger={<span className="text-xs font-medium">{tc[el.route ?? 'straight']}</span>}>
        <div className="flex flex-col gap-1">
          {routes.map((r) => (
            <button key={r} type="button" aria-pressed={(el.route ?? 'straight') === r} className={cn('rounded-md px-3 py-1 text-left text-sm hover:bg-accent', (el.route ?? 'straight') === r && 'bg-accent')} onClick={() => setAll(c, els, { route: r, ...(r !== 'curved' ? { control: null } : {}) })}>
              {tc[r]}
            </button>
          ))}
        </div>
      </BarPopover>
      {(['startCap', 'endCap'] as const).map((which) => (
        <BarPopover key={which} label={tc[which]} trigger={<span className="text-xs">{tc[which]}: {tc.caps[el[which] ?? 'none']}</span>}>
          <div className="flex flex-col gap-1">
            {caps.map((cap) => (
              <button key={cap} type="button" aria-pressed={(el[which] ?? 'none') === cap} className={cn('rounded-md px-3 py-1 text-left text-sm hover:bg-accent', (el[which] ?? 'none') === cap && 'bg-accent')} onClick={() => setAll(c, els, { [which]: cap })}>
                {tc.caps[cap]}
              </button>
            ))}
          </div>
        </BarPopover>
      ))}
      <BarButton
        label={tc.swap}
        onClick={() => c.apply({ type: 'batch', ops: els.map((e) => ({ type: 'set' as const, id: e.id, patch: { start: e.end ?? null, end: e.start ?? null, startCap: e.endCap ?? 'none', endCap: e.startCap ?? 'none' } })) })}
      >
        <ArrowLeftRight />
      </BarButton>
      <StrokeControls c={c} els={els} />
    </>
  );
}
