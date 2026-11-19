/**
 * The lists of a recording, as the standard list (`EntityList` with
 * `TabListRow` rows, as in a record panel's tabs): the pages visited under
 * the player, and the event timeline of the details column. A row click jumps
 * the player there; the row at the playhead is marked.
 */

import { useCallback, useMemo } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { ActivityIllustration, TAB_EMPTY_STATE_TABLE_CLASS } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useI18n } from '@/lib/i18n/provider';
import { applySelectFilters } from '@/lib/list-filters';
import { formatDuration } from '../../lib/format';
import { formatClock, type MarkerKind, type PageVisit, type TimelineMarker } from '../../lib/replay';
import { MARKER_STYLES } from '../player/timeline';

/** Land a little before an event, so the cause is on screen too. */
const LEAD_IN_MS = 1_500;
const MARKER_KINDS: MarkerKind[] = ['page', 'click', 'frustration', 'error', 'custom'];

/** The marked row: the playhead's. */
const CURRENT_ROW = 'bg-accent hover:bg-accent dark:bg-accent dark:hover:bg-accent';

export function markerText(marker: TimelineMarker): string {
  if (marker.kind === 'page' || marker.kind === 'click') return marker.label;
  return marker.name === marker.label ? marker.name : `${marker.name}: ${marker.label}`;
}

/** The last of `offsets` at or before `at`, by index; -1 when none is. */
function currentIndex(offsets: readonly number[], at: number | undefined): number {
  if (at === undefined) return -1;
  let index = -1;
  offsets.forEach((offset, i) => {
    if (offset <= at) index = i;
  });
  return index;
}

interface PageRow {
  id: string;
  step: number;
  path: string;
  title: string;
  offsetMs: number;
  durationMs: number;
}

/** Whether a page row passes the "Time on page" filter: more (`gt`) or less (`lt`) than a number of seconds. */
function matchesTimeOnPage(row: PageRow, operator: string, raw: string): boolean {
  const seconds = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(seconds)) return true;
  const stayed = row.durationMs / 1000;
  return operator === 'lt' ? stayed < seconds : stayed > seconds;
}

/** The pages visited: search, a Filter by page and by time on page, and Page / Time on page / At rows. */
export function PagesPanel({ visits, currentOffset, onJump }: Readonly<{ visits: readonly PageVisit[]; currentOffset: number; onJump: (ms: number) => void }>) {
  const { t, format } = useI18n();
  const tp = t.weldpanel.observe.session.pages;
  const items = useMemo<PageRow[]>(
    () => visits.map((visit, i) => ({ id: `${visit.offsetMs}-${visit.path}`, step: i + 1, path: visit.path, title: visit.title ?? '', offsetMs: visit.offsetMs, durationMs: visit.durationMs })),
    [visits],
  );
  const current = currentIndex(
    items.map((item) => item.offsetMs),
    currentOffset,
  );
  const filters = useMemo<FilterConfig[]>(
    () => [
      {
        field: 'path',
        label: tp.page,
        searchable: true,
        options: [...new Set(items.map((item) => item.path))].sort((a, b) => a.localeCompare(b)).map((path) => ({ value: path, label: path })),
      },
      { field: 'stayed', label: tp.timeOnPageSeconds, filterType: 'number', operators: ['gt', 'lt'], options: [] },
    ],
    [items, tp],
  );
  const applyFilters = useCallback((list: PageRow[], active: ActiveFilter[]) => {
    const byPath = applySelectFilters(list, active, { path: (row, value) => row.path === value });
    const done = active.filter((f) => f.field === 'stayed' && f.operator && f.value !== '');
    return byPath.filter((row) => done.every((f) => matchesTimeOnPage(row, f.operator, f.value)));
  }, []);
  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'page', header: tp.page, width: 'flex-1' },
      { id: 'stayed', header: tp.timeOnPage, width: 'w-[96px]' },
      { id: 'at', header: tp.at, width: 'w-[56px]', className: 'text-right' },
    ],
    [tp],
  );

  const renderRow = useCallback(
    (item: PageRow) => (
      <TabListRow
        key={item.id}
        label={format(tp.jump, { path: item.path })}
        onOpen={() => onJump(item.offsetMs)}
        className={cn(item.step - 1 === current && CURRENT_ROW)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-[11px] font-semibold text-sky-700 dark:text-sky-300">{item.step}</span>
          <span className="truncate text-sm font-medium" title={item.title || undefined}>
            {item.path}
          </span>
        </div>
        <span className="w-[96px] shrink-0 text-sm text-muted-foreground">{formatDuration(item.durationMs / 1000)}</span>
        <span className="w-[56px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatClock(item.offsetMs)}</span>
      </TabListRow>
    ),
    [current, format, onJump, tp],
  );

  return (
    <TabListScope>
      <EntityList<PageRow>
        items={items}
        isLoading={false}
        error={null}
        filters={filters}
        maxFilters={3}
        applyFilters={applyFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={tp.search}
        searchFields={['path', 'title']}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: tp.title, description: tp.empty }}
      />
    </TabListScope>
  );
}

interface EventRow {
  id: string;
  kind: MarkerKind;
  kindLabel: string;
  text: string;
  offsetMs: number;
}

/**
 * The event timeline: search, a Filter by type, and Event / Time rows. The type
 * shows as the dot's colour (the player's legend), not as a column: the column
 * is too narrow for both.
 */
export function EventsPanel({
  markers,
  currentOffset,
  onJump,
}: Readonly<{ markers: readonly TimelineMarker[]; currentOffset?: number; onJump: (ms: number) => void }>) {
  const { t, format } = useI18n();
  const te = t.weldpanel.observe.session.events;
  const items = useMemo<EventRow[]>(
    () => markers.map((marker) => ({ id: marker.id, kind: marker.kind, kindLabel: te.kinds[marker.kind], text: markerText(marker), offsetMs: marker.offsetMs })),
    [markers, te],
  );
  const current = items[currentIndex(
    items.map((item) => item.offsetMs),
    currentOffset,
  )]?.id;

  const filters = useMemo<FilterConfig[]>(
    () => [{ field: 'kind', label: te.type, options: MARKER_KINDS.map((kind) => ({ value: kind, label: te.kinds[kind] })) }],
    [te],
  );
  const applyFilters = useCallback(
    (list: EventRow[], active: ActiveFilter[]) => applySelectFilters(list, active, { kind: (row, value) => row.kind === value }),
    [],
  );
  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'event', header: te.event, width: 'flex-1' },
      { id: 'time', header: te.time, width: 'w-[44px]', className: 'text-right' },
    ],
    [te],
  );

  const renderRow = useCallback(
    (item: EventRow) => (
      <TabListRow
        key={item.id}
        label={`${item.kindLabel}: ${item.text}. ${format(te.jump, { time: formatClock(item.offsetMs) })}`}
        onOpen={() => onJump(Math.max(0, item.offsetMs - LEAD_IN_MS))}
        className={cn(item.id === current && CURRENT_ROW)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', MARKER_STYLES[item.kind])} aria-hidden />
          <span className="truncate text-sm" title={item.text}>
            {item.text}
          </span>
        </div>
        <span className="w-[44px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatClock(item.offsetMs)}</span>
      </TabListRow>
    ),
    [current, format, onJump, te],
  );

  return (
    <TabListScope>
      <EntityList<EventRow>
        items={items}
        isLoading={false}
        error={null}
        filters={filters}
        maxFilters={2}
        applyFilters={applyFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={te.search}
        searchFields={['text', 'kindLabel']}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: te.title, description: te.empty }}
      />
    </TabListScope>
  );
}
