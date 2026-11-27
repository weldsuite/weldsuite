import type { ComponentType, MouseEvent } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export type RecordChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const DOT_CLASSES: Record<RecordChipTone, string> = {
  neutral: 'bg-muted-foreground/60',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-sky-500',
};

export interface RecordChipProps {
  /** The number or name of the record. Always shown, never an id. */
  label: string;
  /** Muted text after the label, for example a date or an amount. */
  secondary?: string;
  /** An icon in front of the label (decorative: the label names the chip). */
  icon?: ComponentType<{ className?: string }>;
  /** Colours the status dot. Pair it with `statusLabel`: colour alone says nothing. */
  tone?: RecordChipTone;
  /** The status in words. Read by screen readers and shown as a tooltip, not drawn. */
  statusLabel?: string;
  /**
   * Where the record lives. Rendered as a real `href`, so Cmd/Ctrl-click and
   * middle-click open it in a new tab.
   */
  href?: string;
  /** A plain click opens the record in place (for example as a stacked panel) instead of navigating. */
  onOpen?: () => void;
  className?: string;
}

/** Whether the click asks the browser for a new tab or window. */
function wantsNewTab(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * A compact link to another record: icon, number or name, optional secondary
 * text and a status dot.
 *
 * It is an `<a href>`, so the browser's own link behaviour is kept for a new
 * tab. A plain click calls `onOpen` and cancels the navigation. It stops the
 * click from reaching a clickable row it sits in. Without an `href` it falls
 * back to a button. It holds no translations: every word comes from props.
 */
export function RecordChip({
  label,
  secondary,
  icon: Icon,
  tone,
  statusLabel,
  href,
  onOpen,
  className,
}: Readonly<RecordChipProps>) {
  const classes = cn(
    'inline-flex min-h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[13px] leading-tight text-foreground no-underline',
    'transition-colors hover:bg-accent hover:text-accent-foreground',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    className,
  );

  const content = (
    <>
      {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      <span className="min-w-0 truncate font-medium">{label}</span>
      {secondary ? <span className="min-w-0 shrink truncate text-muted-foreground">{secondary}</span> : null}
      {tone ? (
        <>
          <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT_CLASSES[tone])} />
          {statusLabel ? <span className="sr-only">{statusLabel}</span> : null}
        </>
      ) : null}
    </>
  );

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    // A chip inside a clickable row must not trigger the row.
    event.stopPropagation();
    if (!onOpen || wantsNewTab(event)) return;
    event.preventDefault();
    onOpen();
  };

  // Middle-click raises `auxclick`, not `click`; keep it from reaching the row too.
  const stop = (event: MouseEvent<HTMLElement>) => event.stopPropagation();

  const tooltip = [label, secondary, statusLabel].filter(Boolean).join(' · ');

  if (!href) {
    return (
      <button type="button" className={classes} title={tooltip} onClick={handleClick} onAuxClick={stop}>
        {content}
      </button>
    );
  }

  return (
    <a href={href} className={classes} title={tooltip} onClick={handleClick} onAuxClick={stop}>
      {content}
    </a>
  );
}
