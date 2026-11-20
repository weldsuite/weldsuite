/**
 * Record cards from a `show_records` spec. The title is looked up live (a
 * renamed ticket shows its new name; one the reader cannot see or that was
 * deleted is greyed out); the rest is what the AI saw when it answered. A
 * click opens the record the way a tagged record in chat does: its sheet, or
 * its page when it has no sheet (cmd/ctrl-click: a new tab).
 */

import { useCallback, useRef, type MouseEvent } from 'react';
import {
  Building2,
  CheckSquare,
  FileText,
  FolderKanban,
  LifeBuoy,
  Receipt,
  Sheet,
  ShoppingCart,
  Target,
  User,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import type { RecordItem, RecordsVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { recordPagePath } from '@weldsuite/app-api-client/schemas/record-links';
import { SEARCH_ENTITY_TYPES_SET } from '@weldsuite/core-api-client/schemas/search';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { cn } from '@/lib/utils';
import { useRouter } from '@/lib/router';
import { toPublicPath } from '@/lib/workspace-url-rewrite';
import { useEntitySheet } from '@/components/entity-sheet/use-entity-sheet';
import { hasEntitySheetRenderer } from '@/components/entity-sheet/registry-meta';
import type { EntitySheetType } from '@/components/entity-sheet/types';
import { hasEntityTitleLookup, useEntityTitle } from '@/app/weldchat/hooks/use-entity-title';
import { useChatVisualActions } from './visual-actions-context';

const ICONS: Partial<Record<RecordItem['entityType'], LucideIcon>> = {
  contact: User,
  customer: Building2,
  lead: UserPlus,
  opportunity: Target,
  ticket: LifeBuoy,
  task: CheckSquare,
  project: FolderKanban,
  invoice: FileText,
  bill: Receipt,
  order: ShoppingCart,
  sheet: Sheet,
};

export interface RecordCardLabels {
  open: (name: string) => string;
  noAccess: (name: string) => string;
  deleted: (name: string) => string;
}

/** The entity sheet's name for a record type, or null for a type it does not know. */
function sheetTypeOf(type: string): EntitySheetType | null {
  return SEARCH_ENTITY_TYPES_SET.has(type) ? (type as EntitySheetType) : null;
}

function RecordCard({ item, labels }: Readonly<{ item: RecordItem; labels: RecordCardLabels }>) {
  const router = useRouter();
  const { open: openEntitySheet } = useEntitySheet();
  const newTab = useRef(false);
  const { lookUpRecords = true } = useChatVisualActions();
  const sheetType = sheetTypeOf(item.entityType);
  // A type the title lookup does not know is never fetched (an empty id disables it).
  const lookedUp = lookUpRecords && sheetType !== null && hasEntityTitleLookup(sheetType);
  const { status, title } = useEntityTitle(sheetType ?? 'task', lookedUp ? item.id : '');
  const hasSheet = sheetType !== null && hasEntitySheetRenderer(sheetType);
  const pageHref = recordPagePath(item.entityType, item.id);
  const name = lookedUp && status === 'ok' && title ? title : item.label;
  const unavailable = lookedUp && (status === 'forbidden' || status === 'notfound');
  const openable = !unavailable && (hasSheet || !!pageHref);
  const Icon = ICONS[item.entityType] ?? FileText;

  const captureIntent = useCallback((event: MouseEvent) => {
    newTab.current = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
  }, []);

  const open = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      const wantsTab = newTab.current;
      newTab.current = false;
      if (wantsTab && pageHref) {
        window.open(toPublicPath(pageHref), '_blank', 'noopener');
        return;
      }
      if (hasSheet && sheetType) openEntitySheet(sheetType, item.id);
      else if (pageHref) router.push(pageHref);
    },
    [hasSheet, sheetType, pageHref, openEntitySheet, item.id, router],
  );

  let tooltip = labels.open(name);
  if (lookedUp && status === 'forbidden') tooltip = labels.noAccess(name);
  else if (status === 'notfound' && lookedUp) tooltip = labels.deleted(name);

  const body = (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn('truncate font-medium', unavailable && 'text-muted-foreground line-through')}>{name}</span>
          {item.status && (
            <SoftBadge tone="neutral" className="shrink-0 text-[11px]">
              {item.status}
            </SoftBadge>
          )}
        </span>
        {item.subtitle && <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>}
        {item.fields && item.fields.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {item.fields.map((field) => (
              <span key={field.label} className="text-muted-foreground">
                {field.label} <span className="text-foreground">{field.value}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </>
  );

  const className = 'flex w-full items-start gap-2.5 rounded-lg border bg-card px-3 py-2 text-left text-sm';
  if (!openable) {
    return (
      <div className={className} title={tooltip}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={tooltip}
      onMouseDown={captureIntent}
      onAuxClick={captureIntent}
      onClick={open}
      className={cn(className, 'transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      {body}
    </button>
  );
}

export function VisualRecords({ visual, labels }: Readonly<{ visual: RecordsVisual; labels: RecordCardLabels }>) {
  return (
    <div className="@container">
      <ul className="grid grid-cols-1 gap-2 @[36rem]:grid-cols-2">
        {visual.items.map((item) => (
          <li key={`${item.entityType}:${item.id}`}>
            <RecordCard item={item} labels={labels} />
          </li>
        ))}
      </ul>
    </div>
  );
}
