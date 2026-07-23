/**
 * Clickable inline chip rendered for each `<@type:id|Label>` token.
 *
 * Click-intent contract (matches `command-palette.tsx`):
 * - plain click           → opens the entity sheet (in-place peek)
 * - cmd/ctrl/shift/middle → opens the page route in a new tab
 *
 * Visual states:
 * - loading            → soft chip with the baked-in fallbackLabel
 * - ok                 → live title from `useEntityTitle`
 * - forbidden/notfound → muted, non-clickable, fallback label + tooltip
 * - missing renderer   → defensive plain-text branch (registry covers all 13
 *                        types today; this preserves correctness if the set
 *                        ever shrinks)
 */

import { useCallback, useRef } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
import { flagSkipNextEntitySheetAnimation } from '@/components/entity-sheet/skip-animation';
import {
  hasEntitySheetRenderer,
  pageHrefForEntity,
} from '@/components/entity-sheet/registry-meta';
import type { EntitySheetType } from '@/components/entity-sheet/types';
import { useEntityTitle } from '../hooks/use-entity-title';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * Per-type color palette. Keeps the same design as user mentions (blue) but
 * assigns each entity type a distinct hue so the reader can scan a message
 * and tell at a glance whether `@Acme` is a customer, a contact, a lead, etc.
 *
 * Values are written as literal class strings (not template-built) so Tailwind's
 * source scanner picks them all up — generating dynamic class names defeats it.
 */
const TYPE_STYLES: Record<EntitySheetType, string> = {
  contact:
    'bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900',
  customer:
    'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900',
  lead:
    'bg-sky-50 text-sky-600 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-400 dark:hover:bg-sky-900',
  opportunity:
    'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-950 dark:text-green-400 dark:hover:bg-green-900',
  ticket:
    'bg-orange-50 text-orange-600 hover:bg-orange-100 dark:bg-orange-950 dark:text-orange-400 dark:hover:bg-orange-900',
  article:
    'bg-cyan-50 text-cyan-700 hover:bg-cyan-100 dark:bg-cyan-950 dark:text-cyan-400 dark:hover:bg-cyan-900',
  product:
    'bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-950 dark:text-violet-400 dark:hover:bg-violet-900',
  order:
    'bg-pink-50 text-pink-600 hover:bg-pink-100 dark:bg-pink-950 dark:text-pink-400 dark:hover:bg-pink-900',
  invoice:
    'bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-400 dark:hover:bg-indigo-900',
  bill:
    'bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950 dark:text-rose-400 dark:hover:bg-rose-900',
  project:
    'bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950 dark:text-purple-400 dark:hover:bg-purple-900',
  task:
    'bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-950 dark:text-teal-400 dark:hover:bg-teal-900',
  domain:
    'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
};

interface EntityMentionChipProps {
  type: EntitySheetType;
  id: string;
  fallbackLabel: string | null;
}

export function EntityMentionChip({ type, id, fallbackLabel }: EntityMentionChipProps) {
  const t = useTranslations();
  const { open: openEntitySheet } = useEntitySheet();
  const newTabRef = useRef(false);
  const { status, title } = useEntityTitle(type, id);

  const captureClickIntent = useCallback((e: React.MouseEvent) => {
    newTabRef.current = e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const newTab = newTabRef.current;
      newTabRef.current = false;
      if (newTab) {
        // Some entities (lead, opportunity) have no full page — fall through
        // to opening the in-app sheet instead of a blank new tab.
        const href = pageHrefForEntity(type, id);
        if (href) {
          window.open(href, '_blank', 'noopener');
          return;
        }
      }
      // The chat already has a right-side panel (members / pinned / entity /
      // thread) — swapping to the entity sheet should snap, not slide.
      flagSkipNextEntitySheetAnimation();
      openEntitySheet(type, id);
    },
    [type, id, openEntitySheet],
  );

  // Defensive: registry covers all 13 types today. If a type is ever removed
  // from the registry, render the chip as plain text rather than crashing.
  // Hooks above this guard run unconditionally so the order is stable.
  if (!hasEntitySheetRenderer(type)) {
    return (
      <span className="inline align-middle text-muted-foreground">
        @{fallbackLabel ?? `${type}:${id}`}
      </span>
    );
  }

  const isUnavailable = status === 'forbidden' || status === 'notfound';
  const display =
    status === 'ok' && title
      ? title
      : fallbackLabel || `${type}:${id}`;
  const tooltip =
    status === 'forbidden'
      ? t('sweep.weldchat.entityMentionChip.noAccess', { name: display })
      : status === 'notfound'
        ? t('sweep.weldchat.entityMentionChip.deleted', { name: display })
        : display;

  if (isUnavailable) {
    return (
      <span
        title={tooltip}
        className="inline-block align-middle rounded px-1.5 py-0.5 text-[12px] font-medium bg-muted text-muted-foreground line-through"
      >
        @{display}
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      type="button"
      title={tooltip}
      onMouseDown={captureClickIntent}
      onAuxClick={captureClickIntent}
      onClick={handleClick}
      className={cn(
        'inline-block align-middle rounded px-1.5 py-0.5 text-[12px] font-medium',
        TYPE_STYLES[type],
        'cursor-pointer transition-colors',
        status === 'loading' && 'opacity-80',
      )}
    >
      @{display}
    </Button>
  );
}
