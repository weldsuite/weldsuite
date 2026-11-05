import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@/lib/utils';

// Toolbar building blocks for the board editor. Buttons keep focus on the
// board (mousedown is prevented), so a click acts on the selection.

export const TOOL_BUTTON =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[18px]';
export const BAR_BUTTON =
  'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-sm text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';

export function WithTooltip({ label, side, children }: { label: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function BarButton({
  label,
  onClick,
  active,
  disabled,
  className,
  side,
  children,
  onDoubleClick,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactNode;
  onDoubleClick?: () => void;
}) {
  return (
    <WithTooltip label={label} side={side}>
      <button
        type="button"
        className={cn(className ?? BAR_BUTTON, active && 'bg-primary/10 text-primary hover:bg-primary/15')}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

export function Divider({ vertical = true }: { vertical?: boolean }) {
  return vertical ? <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden /> : <div className="my-1 h-px w-6 shrink-0 bg-border" aria-hidden />;
}

/** A colour swatch grid. `null` in the list is "none". */
export function Swatches({ colors, value, onPick, noneLabel }: { colors: readonly (string | null)[]; value: string | undefined; onPick: (color: string | null) => void; noneLabel?: string }) {
  return (
    <div className="grid grid-cols-8 gap-1.5">
      {colors.map((color) => (
        <button
          key={color ?? 'none'}
          type="button"
          aria-label={color ?? noneLabel}
          title={color ?? noneLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(color)}
          className={cn(
            'size-6 rounded-full border shadow-sm transition hover:scale-110',
            (value ?? null) === color && 'ring-2 ring-primary ring-offset-1',
            !color && 'bg-[linear-gradient(135deg,transparent_45%,#ef4444_45%,#ef4444_55%,transparent_55%)]',
          )}
          style={color ? { backgroundColor: color } : undefined}
        />
      ))}
    </div>
  );
}

/** A toolbar button that opens a small panel. */
export function BarPopover({
  label,
  trigger,
  children,
  side = 'bottom',
  active,
  className,
  open,
  onOpenChange,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  active?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <WithTooltip label={label} side={side === 'right' ? 'right' : 'top'}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(className ?? BAR_BUTTON, active && 'bg-primary/10 text-primary')}
            onMouseDown={(e) => e.preventDefault()}
          >
            {trigger}
          </button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent side={side} align="start" className="w-auto p-2" onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
