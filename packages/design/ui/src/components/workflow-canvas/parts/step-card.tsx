"use client"

/**
 * The card every node on the workflow canvas is drawn as: trigger, action,
 * condition and condition branch. One component, so they are the same card
 * down to the pixel and only differ in icon, title, type label and summary.
 *
 *   [icon] Title ......................... [Type]
 *   ------------------------------------------------
 *   One-line summary
 *
 * Its size comes from the layout constants (`NODE_WIDTH` / `NODE_HEIGHT`), so
 * the card and the maths that positions it cannot drift apart.
 */

import * as React from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { NODE_HEIGHT, NODE_WIDTH } from '../flow-utils';

/** `attention`: the step still needs configuration. */
export type StepCardState = 'default' | 'selected' | 'attention';

const CARD_BASE =
  'relative flex flex-col rounded-xl border bg-white text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] dark:bg-background dark:shadow-none';

const CARD_STATE: Record<StepCardState, string> = {
  default: 'border-border hover:border-foreground/25',
  selected: 'border-blue-500 ring-[3px] ring-blue-500/15',
  attention: 'border-amber-400/80 hover:border-amber-400 dark:border-amber-500/50 dark:hover:border-amber-500/70',
};

/** The platform's label (22px, 12px medium, slightly rounded), in the neutral tone. */
const TYPE_LABEL =
  'inline-flex h-[22px] flex-shrink-0 items-center rounded bg-muted px-2 text-[12px] font-medium leading-none text-muted-foreground';

export function StepCard({
  as = 'div',
  icon: Icon,
  title,
  typeLabel,
  summary,
  monoSummary,
  state = 'default',
  onClick,
}: Readonly<{
  /** `button` when the card itself is the click target. */
  as?: 'div' | 'button';
  icon: React.ElementType;
  title: React.ReactNode;
  typeLabel: React.ReactNode;
  summary?: React.ReactNode;
  /** The summary is an expression (a condition), not a sentence. */
  monoSummary?: boolean;
  state?: StepCardState;
  onClick?: () => void;
}>) {
  // Header (icon, title, type) over a hairline and the summary, with 12px side
  // padding throughout. The header is 44px; the summary strip takes the rest
  // of `NODE_HEIGHT` (the hairline is part of it). A card without a summary is
  // its header.
  const body = (
    <>
      <div className={cn('flex flex-shrink-0 items-center justify-between gap-2 px-3', summary ? 'h-11' : 'flex-1')}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 flex-shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="size-3.5 text-muted-foreground" />
          </div>
          <span className="truncate text-sm font-medium leading-5 text-foreground">{title}</span>
        </div>
        <span className={TYPE_LABEL}>{typeLabel}</span>
      </div>
      {summary ? (
        <div className="mx-3 flex min-w-0 flex-1 items-center border-t border-border">
          <p
            className={cn(
              'w-full truncate text-xs leading-4 text-muted-foreground',
              monoSummary && 'font-mono text-[11px]',
            )}
          >
            {summary}
          </p>
        </div>
      ) : null}
    </>
  );
  const className = cn(CARD_BASE, CARD_STATE[state]);
  const style = { width: NODE_WIDTH, height: NODE_HEIGHT };

  if (as === 'button') {
    return (
      <button type="button" className={className} style={style} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

/** The slot a new step will take, while its type is being chosen. */
export function StepCardPlaceholder() {
  return (
    <div
      className="flex items-center justify-center rounded-xl border border-dashed border-border bg-white dark:bg-background"
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Plus className="size-4 text-muted-foreground/60" />
    </div>
  );
}

/** Sits on the top edge of a card that still needs configuration. */
export function SetupRequiredBadge({ label }: Readonly<{ label?: string }>) {
  return (
    <div className="absolute -top-2.5 left-3 z-20 flex h-5 items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 dark:border-amber-500/40 dark:bg-amber-950">
      <AlertCircle className="size-3 text-amber-600 dark:text-amber-400" />
      <span className="whitespace-nowrap text-[11px] font-medium leading-none text-amber-700 dark:text-amber-300">
        {label || 'Setup required'}
      </span>
    </div>
  );
}

/** The dot a connector leaves a card from, centred on its bottom edge. */
export const STEP_HANDLE_CLASS =
  '!h-2.5 !w-2.5 !min-h-0 !min-w-0 !border-[1.5px] !border-blue-400 !bg-white dark:!bg-background';
