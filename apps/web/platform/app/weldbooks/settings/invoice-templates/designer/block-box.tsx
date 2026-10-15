import { memo, type PointerEvent as ReactPointerEvent } from 'react';
import { EyeOff, ImageIcon, Lock } from 'lucide-react';
import type { TemplateBlock } from '@weldsuite/books-domain/invoice-template/schema';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@/lib/utils';
import { isPlaceholderImage } from './model/block-factory';
import { RESIZE_HANDLES, type ResizeHandle } from './model/snapping';

/** Pixels a block's hit area is at least, so lines and slim blocks stay easy to grab. */
const MIN_HIT = 10;

const HANDLE_POSITION: Record<ResizeHandle, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
  s: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
  sw: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

export interface BlockBoxProps {
  block: TemplateBlock;
  scale: number;
  selected: boolean;
  /** Only one block is selected: it gets the resize handles and the name chip. */
  single: boolean;
  /** Pointer interaction is off (read-only). */
  readOnly: boolean;
  /** Translated type name for the chip. */
  name: string;
  everyPageLabel: string;
  followsTableLabel: string;
  lockedLabel: string;
  hiddenLabel: string;
  chooseImageLabel: string;
  /** Why the block prints elsewhere or taller than designed; null when it does not. */
  hint: string | null;
  hintTone: 'warn' | 'info';
  belowTable: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void;
  onHandleDown: (event: ReactPointerEvent<HTMLSpanElement>, id: string, handle: ResizeHandle) => void;
}

interface BoxClassState {
  locked: boolean;
  readOnly: boolean;
  hidden: boolean;
  warn: boolean;
  selected: boolean;
  emptyImage: boolean;
}

function boxClassName({ locked, readOnly, hidden, warn, selected, emptyImage }: BoxClassState): string {
  return cn(
    'group/block absolute select-none outline-offset-0',
    locked || readOnly ? 'cursor-default' : 'cursor-move',
    // Hidden blocks are not printed: faint outline only.
    hidden && 'outline outline-1 outline-dashed outline-muted-foreground/40',
    !hidden && 'hover:outline hover:outline-1 hover:outline-primary/60',
    warn && !selected && 'outline outline-1 outline-dashed outline-amber-500/80',
    selected && 'outline outline-2 outline-primary',
    emptyImage && !selected && 'bg-muted/50 outline outline-1 outline-dashed outline-muted-foreground/40',
  );
}

interface BlockBadgesProps {
  everyPage: boolean;
  hidden: boolean;
  lockedBadge: boolean;
  emptyImage: boolean;
  /** Pixel height of the block, for deciding whether the empty-image caption fits. */
  pxHeight: number;
  nameChip: boolean;
  belowTable: boolean;
  name: string;
  everyPageLabel: string;
  followsTableLabel: string;
  lockedLabel: string;
  hiddenLabel: string;
  chooseImageLabel: string;
}

/** The icons and chips drawn on a block's box. */
function BlockBadges({
  everyPage,
  hidden,
  lockedBadge,
  emptyImage,
  pxHeight,
  nameChip,
  belowTable,
  name,
  everyPageLabel,
  followsTableLabel,
  lockedLabel,
  hiddenLabel,
  chooseImageLabel,
}: Readonly<BlockBadgesProps>) {
  return (
    <>
      {emptyImage ? (
        <span className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-1 overflow-hidden text-[10px] text-muted-foreground">
          <ImageIcon className="h-4 w-4 shrink-0" aria-hidden />
          {pxHeight > 36 ? chooseImageLabel : null}
        </span>
      ) : null}

      {hidden ? (
        <span className="pointer-events-none absolute left-1 top-1 rounded bg-background/80 p-0.5 text-muted-foreground" title={hiddenLabel}>
          <EyeOff className="h-3 w-3" aria-hidden />
        </span>
      ) : null}

      {lockedBadge ? (
        <span className="pointer-events-none absolute -right-1 -top-1 rounded-full bg-primary p-0.5 text-primary-foreground" title={lockedLabel}>
          <Lock className="h-2.5 w-2.5" aria-hidden />
        </span>
      ) : null}

      {everyPage ? (
        <span className="pointer-events-none absolute -top-2 right-1 whitespace-nowrap rounded-full bg-primary px-1.5 py-px text-[9px] font-medium leading-3 text-primary-foreground shadow-sm">
          {everyPageLabel}
        </span>
      ) : null}

      {nameChip ? (
        <span className="pointer-events-none absolute -top-5 left-0 flex items-center gap-1 whitespace-nowrap rounded bg-primary px-1.5 py-px text-[10px] font-medium leading-4 text-primary-foreground">
          {name}
          {belowTable ? <span className="opacity-80">· {followsTableLabel}</span> : null}
        </span>
      ) : null}
    </>
  );
}

/** The interaction box of one block, on top of the rendered page. */
export const BlockBox = memo(function BlockBox({
  block,
  scale,
  selected,
  single,
  readOnly,
  name,
  everyPageLabel,
  followsTableLabel,
  lockedLabel,
  hiddenLabel,
  chooseImageLabel,
  hint,
  hintTone,
  belowTable,
  onPointerDown,
  onHandleDown,
}: Readonly<BlockBoxProps>) {
  const px = { w: block.w * scale, h: block.h * scale };
  const w = Math.max(px.w, MIN_HIT);
  const h = Math.max(px.h, MIN_HIT);
  const left = block.x * scale - (w - px.w) / 2;
  const top = block.y * scale - (h - px.h) / 2;
  const locked = Boolean(block.locked);
  const hidden = Boolean(block.hidden);
  const emptyImage = block.type === 'image' && isPlaceholderImage(block.src);

  const box = (
    <div
      data-block-id={block.id}
      role="button"
      aria-label={name}
      aria-pressed={selected}
      tabIndex={-1}
      onPointerDown={(e) => onPointerDown(e, block.id)}
      className={boxClassName({ locked, readOnly, hidden, warn: Boolean(hint) && hintTone === 'warn', selected, emptyImage })}
      style={{ left, top, width: w, height: h }}
    >
      <BlockBadges
        everyPage={Boolean(block.everyPage)}
        hidden={hidden}
        lockedBadge={locked && selected}
        emptyImage={emptyImage}
        pxHeight={px.h}
        nameChip={selected && single}
        belowTable={belowTable}
        name={name}
        everyPageLabel={everyPageLabel}
        followsTableLabel={followsTableLabel}
        lockedLabel={lockedLabel}
        hiddenLabel={hiddenLabel}
        chooseImageLabel={chooseImageLabel}
      />

      {selected && single && !locked && !readOnly
        ? RESIZE_HANDLES.map((handle) => (
            <span
              key={handle}
              data-handle={handle}
              onPointerDown={(e) => onHandleDown(e, block.id, handle)}
              className={cn(
                'absolute h-2 w-2 rounded-[2px] border border-primary bg-background shadow-sm before:absolute before:-inset-1.5 before:content-[""]',
                HANDLE_POSITION[handle],
              )}
            />
          ))
        : null}
    </div>
  );

  if (!hint) return box;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{box}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
});
