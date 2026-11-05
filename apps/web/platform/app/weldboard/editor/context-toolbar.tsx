import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
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
  Trash2,
  Underline,
  Ungroup,
} from 'lucide-react';
import {
  alignOps,
  distributeOps,
  keyAllowed,
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
  type ShapeKind,
} from '@weldsuite/board-engine';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { toScreen } from './model/camera';
import { duplicateSelection } from './model/clipboard';
import { hasMark, setMark, toggleMark } from './model/text-editing';
import { ShapeIcon } from './toolbar';
import { BarButton, BarPopover, Divider, Swatches } from './ui';

export interface ContextActions {
  onLink: () => void;
  onComment?: (elementId: string) => void;
  onToTasks?: (ids: string[]) => void;
  onCopyLink?: (id: string) => void;
  onPresentFrom?: (frameId: string) => void;
  onOpenRecord?: (el: BoardElement) => void;
  onExportSelection?: () => void;
  onRenameFrame?: (id: string) => void;
  onAltText?: (id: string) => void;
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

/** Bold and friends on whole elements (no text being edited). */
function markAll(c: BoardController, els: BoardElement[], mark: 'b' | 'i' | 'u' | 's'): void {
  const texty = els.filter((e) => e.text?.text);
  const all = texty.every((e) => e.text!.marks.length > 0 && e.text!.marks.every(([, m]) => !!m[mark]));
  c.apply({ type: 'batch', ops: texty.map((e) => ({ type: 'formatText' as const, id: e.id, at: 0, runs: [[e.text!.text.length, { [mark]: all ? null : true }]] as [number, Record<string, true | null>][] })) });
}

export function ContextToolbar({ controller: c, actions }: { controller: BoardController; actions: ContextActions }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  const ts = te.style;
  const ta = te.actions;
  const els = c.selected;
  const box = c.selectionRect();
  if (!els.length || !box || c.readOnly) return null;
  if (c.transient.marquee || c.transient.guides) return null;

  const top = toScreen(c.camera, { x: box.x + box.w / 2, y: box.y });
  const bottom = toScreen(c.camera, { x: box.x + box.w / 2, y: box.y + box.h });
  const above = top.y > 72;
  const style = { left: Math.max(8, Math.min(c.viewport.width - 8, top.x)), top: above ? top.y - 56 : Math.min(c.viewport.height - 56, bottom.y + 16) };

  const types = new Set(els.map((e) => e.type));
  const only = types.size === 1 ? els[0]!.type : null;
  const single = els.length === 1 ? els[0]! : null;
  const locked = els.every((e) => e.locked);
  const editing = c.editing;
  const hasText = els.some((e) => keyAllowed(e.type, 'text'));

  const lockButton = (
    <BarButton label={locked ? ta.unlock : ta.lock} onClick={() => setAll(c, els, { locked: !locked })}>
      {locked ? <LockOpen /> : <Lock />}
    </BarButton>
  );

  if (locked) {
    return (
      <div className="pointer-events-auto absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-background p-1 shadow-lg" style={style}>
        {lockButton}
      </div>
    );
  }

  return (
    <div
      className="pointer-events-auto absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-background p-1 shadow-lg"
      style={style}
      role="toolbar"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {editing ? (
        <>
          <BarButton label={ts.bold} active={hasMark(c, 'b')} onClick={() => toggleMark(c, 'b')}>
            <Bold />
          </BarButton>
          <BarButton label={ts.italic} active={hasMark(c, 'i')} onClick={() => toggleMark(c, 'i')}>
            <Italic />
          </BarButton>
          <BarButton label={ts.underline} active={hasMark(c, 'u')} onClick={() => toggleMark(c, 'u')}>
            <Underline />
          </BarButton>
          <BarButton label={ts.strike} active={hasMark(c, 's')} onClick={() => toggleMark(c, 's')}>
            <Strikethrough />
          </BarButton>
          <BarPopover label={ts.textColor} trigger={<span className="text-sm font-semibold underline decoration-2">A</span>}>
            <Swatches colors={PALETTE} value={undefined} onPick={(color) => setMark(c, 'c', color)} />
          </BarPopover>
          <BarPopover label={ts.highlight} trigger={<Highlighter />}>
            <Swatches colors={[null, '#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#ddd6fe', '#e5e7eb']} noneLabel={ts.noHighlight} value={undefined} onPick={(color) => setMark(c, 'h', color)} />
          </BarPopover>
          <BarButton label={ts.link} onClick={actions.onLink}>
            <Link2 />
          </BarButton>
        </>
      ) : (
        <>
          {only === 'sticky' && (
            <>
              <BarPopover label={ts.stickyColor} trigger={<span className="size-5 rounded-sm border shadow-sm" style={{ backgroundColor: single?.fill ?? els[0]!.fill }} />}>
                <Swatches colors={STICKY_COLORS} value={single?.fill} onPick={(color) => color && setAll(c, els, { fill: color })} />
              </BarPopover>
              <FontSize c={c} els={els} auto />
            </>
          )}
          {(only === 'shape' || only === 'card' || only === 'frame' || only === 'text') && (
            <BarPopover label={ts.fill} trigger={<span className={cn('size-5 rounded-sm border shadow-sm', !els[0]!.fill || els[0]!.fill === 'transparent' ? 'bg-[linear-gradient(135deg,transparent_45%,#ef4444_45%,#ef4444_55%,transparent_55%)]' : '')} style={{ backgroundColor: els[0]!.fill !== 'transparent' ? els[0]!.fill : undefined }} />}>
              <div className="flex flex-col gap-2">
                <Swatches colors={['transparent', ...SHAPE_FILLS]} value={els[0]!.fill} onPick={(color) => color && setAll(c, els, { fill: color })} />
                <Swatches colors={PALETTE} value={els[0]!.fill} onPick={(color) => color && setAll(c, els, { fill: color })} />
              </div>
            </BarPopover>
          )}
          {only === 'shape' && (
            <>
              <BarPopover label={ts.shape} trigger={<ShapeIcon kind={els[0]!.shape ?? 'rectangle'} />}>
                <div className="grid grid-cols-6 gap-1">
                  {(['rectangle', 'rounded', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'parallelogram', 'cloud', 'callout', 'cylinder', 'terminator', 'document', 'data', 'predefined', 'chevron', 'arrow-right'] as ShapeKind[]).map((kind) => (
                    <button key={kind} type="button" title={te.shapes[kind]} aria-label={te.shapes[kind]} className="flex size-9 items-center justify-center rounded-md hover:bg-accent" onClick={() => setAll(c, els, { shape: kind })}>
                      <ShapeIcon kind={kind} />
                    </button>
                  ))}
                </div>
              </BarPopover>
              <StrokeControls c={c} els={els} />
            </>
          )}
          {only === 'connector' && <ConnectorControls c={c} els={els} />}
          {only === 'pen' && <StrokeControls c={c} els={els} />}
          {only === 'card' && (
            <BarPopover label={ts.color} trigger={<span className="size-5 rounded-sm border-l-4" style={{ borderColor: els[0]!.stroke ?? '#3b82f6' }} />}>
              <Swatches colors={PALETTE} value={els[0]!.stroke} onPick={(color) => color && setAll(c, els, { stroke: color })} />
            </BarPopover>
          )}
          {hasText && only !== 'connector' && only !== 'sticky' && <FontSize c={c} els={els} />}
          {hasText && only !== 'connector' && (
            <>
              <BarPopover label={ts.textColor} trigger={<span className="text-sm font-semibold underline decoration-2" style={{ textDecorationColor: els[0]!.textColor ?? '#1f2937' }}>A</span>}>
                <Swatches colors={PALETTE} value={els[0]!.textColor} onPick={(color) => color && setAll(c, els, { textColor: color })} />
              </BarPopover>
              <BarButton label={ts.bold} onClick={() => markAll(c, els, 'b')}>
                <Bold />
              </BarButton>
              <AlignControl c={c} els={els} />
            </>
          )}
          {only === 'frame' && single && (
            <>
              <BarButton label={ta.renameFrame} onClick={() => actions.onRenameFrame?.(single.id)}>
                <span className="text-xs font-medium">Aa</span>
              </BarButton>
              <BarButton
                label={single.slide !== undefined ? ta.removeFromSlides : ta.addToSlides}
                active={single.slide !== undefined}
                onClick={() => {
                  const max = Math.max(-1, ...[...c.board.elements.values()].filter((e) => e.type === 'frame' && e.slide !== undefined).map((e) => e.slide!));
                  setAll(c, [single], { slide: single.slide !== undefined ? null : max + 1 });
                }}
              >
                <Presentation />
              </BarButton>
            </>
          )}
          {els.length > 1 && (
            <>
              <Divider />
              <BarPopover label={ta.arrange} trigger={<AlignHorizontalJustifyCenter />}>
                <div className="grid grid-cols-4 gap-1">
                  {(
                    [
                      ['left', ta.alignLeft],
                      ['center', ta.alignCenter],
                      ['right', ta.alignRight],
                      ['top', ta.alignTop],
                      ['middle', ta.alignMiddle],
                      ['bottom', ta.alignBottom],
                    ] as const
                  ).map(([mode, label]) => (
                    <button key={mode} type="button" className="rounded-md px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => c.apply(alignOps(c.board, c.selection, mode))}>
                      {label}
                    </button>
                  ))}
                  <button type="button" className="col-span-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => c.apply(distributeOps(c.board, c.selection, 'x'))}>
                    <AlignHorizontalJustifyCenter className="mr-1 inline size-3.5" />
                    {ta.distributeH}
                  </button>
                  <button type="button" className="col-span-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent" onClick={() => c.apply(distributeOps(c.board, c.selection, 'y'))}>
                    <AlignVerticalJustifyCenter className="mr-1 inline size-3.5" />
                    {ta.distributeV}
                  </button>
                </div>
              </BarPopover>
              <BarButton
                label={ta.group}
                onClick={() => {
                  const id = newId('g');
                  c.apply(groupOps(c.board, [...c.selection], id), { select: [id] });
                }}
              >
                <Group />
              </BarButton>
            </>
          )}
          {only === 'group' && single && (
            <BarButton label={ta.ungroup} onClick={() => c.apply(ungroupOps(c.board, single.id), { select: c.board.childIds(single.id) })}>
              <Ungroup />
            </BarButton>
          )}
          <Divider />
          <BarButton label={ts.link} active={!!single?.link} onClick={actions.onLink}>
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
              <DropdownMenuItem onSelect={() => duplicateSelection(c)}>{ta.duplicate}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'front'))}>{ta.bringFront}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'forward'))}>{ta.bringForward}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'backward'))}>{ta.sendBackward}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c.apply(stackOps(c.board, c.selection, 'back'))}>{ta.sendBack}</DropdownMenuItem>
              {single && actions.onCopyLink && <DropdownMenuItem onSelect={() => actions.onCopyLink!(single.id)}>{ta.copyLink}</DropdownMenuItem>}
              {single && actions.onComment && <DropdownMenuItem onSelect={() => actions.onComment!(single.id)}>{ta.addComment}</DropdownMenuItem>}
              {actions.onToTasks && els.some((e) => e.type === 'sticky' || e.type === 'card' || e.type === 'shape') && (
                <DropdownMenuItem onSelect={() => actions.onToTasks!(els.filter((e) => e.type === 'sticky' || e.type === 'card' || e.type === 'shape').map((e) => e.id))}>{ta.toTask}</DropdownMenuItem>
              )}
              {single?.type === 'frame' && actions.onPresentFrom && <DropdownMenuItem onSelect={() => actions.onPresentFrom!(single.id)}>{ta.presentFromHere}</DropdownMenuItem>}
              {single?.type === 'record' && actions.onOpenRecord && <DropdownMenuItem onSelect={() => actions.onOpenRecord!(single)}>{ta.openRecord}</DropdownMenuItem>}
              {single?.type === 'image' && actions.onAltText && <DropdownMenuItem onSelect={() => actions.onAltText!(single.id)}>{ta.altText}</DropdownMenuItem>}
              {single?.type === 'image' && single.crop && <DropdownMenuItem onSelect={() => setAll(c, [single], { crop: null })}>{ta.resetCrop}</DropdownMenuItem>}
              {single && single.type !== 'connector' && single.type !== 'pen' && (
                <DropdownMenuItem onSelect={() => setAll(c, [single], { rotation: (((single.rotation ?? 0) + Math.PI / 2 + Math.PI) % (Math.PI * 2)) - Math.PI })}>{ta.rotate}</DropdownMenuItem>
              )}
              {actions.onExportSelection && <DropdownMenuItem onSelect={actions.onExportSelection}>{ta.exportSelection}</DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onSelect={() => c.deleteSelection()}>
                <Trash2 className="mr-2 size-4" />
                {ta.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

function FontSize({ c, els, auto }: { c: BoardController; els: BoardElement[]; auto?: boolean }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const current = els[0]!.fontSize;
  return (
    <BarPopover label={ts.fontSize} trigger={<span className="min-w-6 text-xs font-medium tabular-nums">{els[0]!.autoFit && auto ? ts.autoSize : (current ?? 16)}</span>}>
      <div className="flex flex-col gap-1">
        {auto && (
          <button type="button" className="rounded-md px-3 py-1 text-left text-sm hover:bg-accent" onClick={() => setAll(c, els, { autoFit: true, fontSize: 22 })}>
            {ts.autoSize}
          </button>
        )}
        {FONT_SIZES.map((f) => (
          <button key={f.label} type="button" className="rounded-md px-3 py-1 text-left text-sm hover:bg-accent" onClick={() => setAll(c, els, { fontSize: f.size, autoFit: false })}>
            {f.label} · {f.size}
          </button>
        ))}
        <div className="flex gap-1 pt-1">
          {[10, 12, 16, 24, 40, 64, 96].map((s) => (
            <button key={s} type="button" className="rounded px-1.5 py-0.5 text-xs tabular-nums hover:bg-accent" onClick={() => setAll(c, els, { fontSize: s, autoFit: false })}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </BarPopover>
  );
}

function AlignControl({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const align = els[0]!.textAlign ?? (els[0]!.type === 'text' ? 'left' : 'center');
  const next = align === 'left' ? 'center' : align === 'center' ? 'right' : 'left';
  const Icon = align === 'left' ? AlignLeft : align === 'center' ? AlignCenter : AlignRight;
  return (
    <BarButton label={ts.align} onClick={() => setAll(c, els, { textAlign: next })}>
      <Icon />
    </BarButton>
  );
}

function StrokeControls({ c, els }: { c: BoardController; els: BoardElement[] }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.style;
  const el = els[0]!;
  return (
    <BarPopover label={ts.stroke} trigger={<span className="size-5 rounded-sm border-[3px]" style={{ borderColor: el.stroke ?? '#1f2937' }} />}>
      <div className="flex w-64 flex-col gap-2">
        <Swatches colors={el.type === 'pen' ? PALETTE : ['transparent', ...PALETTE]} value={el.stroke} onPick={(color) => color && setAll(c, els, { stroke: color })} />
        <div className="flex items-center gap-1">
          <span className="w-20 text-xs text-muted-foreground">{ts.strokeWidth}</span>
          {[1, 2, 4, 6, 10].map((w) => (
            <button key={w} type="button" aria-label={`${w}`} className={cn('flex size-8 items-center justify-center rounded-md hover:bg-accent', el.strokeWidth === w && 'bg-accent')} onClick={() => setAll(c, els, { strokeWidth: w })}>
              <span className="w-5 rounded-full bg-foreground" style={{ height: Math.max(1, w / 1.5) }} />
            </button>
          ))}
        </div>
        {el.type !== 'pen' && (
          <div className="flex items-center gap-1">
            <span className="w-20 text-xs text-muted-foreground">{ts.strokeStyle}</span>
            {(['solid', 'dashed', 'dotted'] as const).map((s) => (
              <button key={s} type="button" className={cn('rounded-md px-2 py-1 text-xs hover:bg-accent', (el.strokeStyle ?? 'solid') === s && 'bg-accent')} onClick={() => setAll(c, els, { strokeStyle: s === 'solid' ? null : s })}>
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
            <button key={r} type="button" className={cn('rounded-md px-3 py-1 text-left text-sm hover:bg-accent', el.route === r && 'bg-accent')} onClick={() => setAll(c, els, { route: r, ...(r !== 'curved' ? { control: null } : {}) })}>
              {tc[r]}
            </button>
          ))}
        </div>
      </BarPopover>
      {(['startCap', 'endCap'] as const).map((which) => (
        <BarPopover key={which} label={tc[which]} trigger={<span className="text-xs">{tc[which]}: {tc.caps[el[which] ?? 'none']}</span>}>
          <div className="flex flex-col gap-1">
            {caps.map((cap) => (
              <button key={cap} type="button" className={cn('rounded-md px-3 py-1 text-left text-sm hover:bg-accent', (el[which] ?? 'none') === cap && 'bg-accent')} onClick={() => setAll(c, els, { [which]: cap })}>
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
