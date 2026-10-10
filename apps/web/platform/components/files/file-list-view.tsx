/**
 * `FileListView` — the canonical WeldDrive list-view file table, extracted into
 * a reusable component so surfaces outside the Drive page (object-panel Files
 * tabs, etc.) render the *exact* same design.
 *
 * It mirrors the WeldDrive list row 1:1 — 51px rows, the type-coloured file
 * icon + name + star, a capitalised Type column, an optional Source badge, a
 * monospace Size column, and a monospace Modified date, with a hover-revealed
 * actions menu. The visual tokens (icons, badge styles, formatters) are imported
 * straight from `drive-file-card.tsx` so the two stay in lockstep.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MoreVertical, Star } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  EntityList,
  type HeaderColumn,
  type SortState,
} from '@/components/entity-list';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  fileTypeIcons,
  sourceBadgeStyles,
  driveLabelClass,
  formatFileSize,
  formatDate,
} from '@/app/welddrive/components/drive-file-card';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';

/** Normalised shape a row needs to render in the WeldDrive list design. */
export interface FileListItem {
  id: string;
  name: string;
  /** Category key into `fileTypeIcons` — 'image' | 'pdf' | 'document' | … */
  fileType: string;
  /** Badge colour key into `sourceBadgeStyles` (only used when `showSource`). */
  source?: string;
  /** Badge label (only rendered when `showSource`). */
  sourceLabel?: string;
  fileSize: number | null;
  createdAt: string;
  isStarred?: boolean;
}

/**
 * Below this width the five-column table (name / type / size / modified / menu
 * need ~650px) can't fit, so the list switches to a compact two-line row. An
 * object panel is 400px wide and its expanded form shares the row with the chat,
 * so this is the normal case there, not an edge case. Measured on the list's own
 * box rather than the viewport, since the panel width is independent of it.
 */
const COMPACT_BELOW_PX = 680;

/** Tracks an element's content width; `null` until it has been measured. */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? null);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface FileListViewProps {
  items: FileListItem[];
  isLoading?: boolean;
  error?: Error | null;
  /** Render the Source badge column. Off by default — single-source surfaces
   *  (object-panel Files tabs) don't need it and it costs horizontal space. */
  showSource?: boolean;
  onRowClick?: (item: FileListItem) => void;
  onRowDoubleClick?: (item: FileListItem) => void;
  /** Returns the dropdown menu items for a row; the trigger + container are
   *  provided here so every consumer gets the identical actions affordance. */
  renderRowMenu?: (item: FileListItem) => ReactNode;
  searchPlaceholder?: string;
  /** Buttons rendered on the right of the top bar (e.g. an Upload button). */
  actionButtons?: ReactNode;
  emptyState?: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
  };
  noResultsState?: { title: string; description: string };
}

export function FileListView({
  items,
  isLoading,
  error,
  showSource = false,
  onRowClick,
  onRowDoubleClick,
  renderRowMenu,
  searchPlaceholder,
  actionButtons,
  emptyState,
  noResultsState,
}: Readonly<FileListViewProps>) {
  const { t } = useI18n();
  const st = useTranslations();
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [containerRef, containerWidth] = useElementWidth<HTMLDivElement>();
  const isCompact = containerWidth !== null && containerWidth < COMPACT_BELOW_PX;

  const headerColumns: HeaderColumn[] = useMemo(() => {
    const cols: HeaderColumn[] = [
      { id: 'name', header: t.welddrive.page.columns.name, width: 'min-w-[160px] flex-1', sortable: true },
      { id: 'fileType', header: t.welddrive.page.columns.type, width: 'w-[120px]', sortable: true },
    ];
    if (showSource) {
      cols.push({ id: 'source', header: t.welddrive.page.columns.source, width: 'w-[140px]', sortable: true });
    }
    cols.push(
      { id: 'fileSize', header: t.welddrive.page.columns.size, width: 'w-[100px]', sortable: true },
      { id: 'createdAt', header: t.welddrive.page.columns.modified, width: 'w-[130px]', sortable: true },
    );
    return cols;
  }, [t, showSource]);

  const handleSort = useCallback((columnId: string) => {
    setSortState((prev) =>
      prev?.columnId === columnId
        ? { columnId, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { columnId, direction: 'asc' },
    );
  }, []);

  const sortedItems = useMemo(() => {
    if (!sortState) return items;
    const { columnId, direction } = sortState;
    const dir = direction === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (columnId) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'fileType': av = a.fileType; bv = b.fileType; break;
        case 'source': av = a.sourceLabel ?? ''; bv = b.sourceLabel ?? ''; break;
        case 'fileSize': av = a.fileSize ?? -1; bv = b.fileSize ?? -1; break;
        case 'createdAt': av = a.createdAt; bv = b.createdAt; break;
        default: return 0;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [items, sortState]);

  const renderRow = useCallback(
    (item: FileListItem) => {
      const typeConfig = fileTypeIcons[item.fileType] || fileTypeIcons.file;
      const Icon = typeConfig.icon;
      const badgeClass = sourceBadgeStyles[item.source ?? ''] || sourceBadgeStyles.drive;

      // The ⋮ menu, shared by both layouts. Hover-revealed on the wide table
      // but kept visible when compact: a narrow panel is often a touch / no-hover
      // surface, and the menu is the only way to delete or download a file.
      // Still revealed by keyboard focus and while its menu is open.
      const actionsMenu = renderRowMenu && (
        <div
          className={cn(
            'relative z-[1] transition-opacity',
            !isCompact &&
              'opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="p-1 rounded-md hover:bg-muted"
                aria-label={st('sweep.entities.moreActions')}
              >
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52" sideOffset={4}>
              {renderRowMenu(item)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      );

      if (isCompact) {
        // Compact: icon + name on the first line, "size · modified" as muted
        // secondary text under it, menu on the right. Nothing has a fixed width
        // wider than the menu button, so the row always fits its column.
        const meta = [item.fileSize ? formatFileSize(item.fileSize) : null, item.createdAt ? formatDate(item.createdAt) : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <div
            key={item.id}
            className="relative flex min-h-[56px] items-center gap-2 px-4 py-2 cursor-pointer border-b border-gray-200/70 dark:border-border group transition-colors hover:bg-gray-50 dark:hover:bg-secondary/50"
          >
            <RowOverlayButton
              label={item.name}
              onClick={() => onRowClick?.(item)}
              onDoubleClick={() => onRowDoubleClick?.(item)}
            />
            <Icon className={cn('h-4 w-4 shrink-0', typeConfig.color)} />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{item.name}</span>
                {item.isStarred && <Star className="h-3.5 w-3.5 shrink-0 text-yellow-400 fill-yellow-400" />}
              </div>
              <div className="flex min-w-0 items-center gap-2">
                {showSource && item.sourceLabel && (
                  <span className={cn(driveLabelClass, badgeClass, 'shrink-0')}>{item.sourceLabel}</span>
                )}
                {meta && (
                  <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">{meta}</span>
                )}
              </div>
            </div>
            {actionsMenu}
          </div>
        );
      }

      return (
        <div
          key={item.id}
          className="relative flex items-center gap-4 px-4 cursor-pointer border-b border-gray-200/70 dark:border-border group transition-colors hover:bg-gray-50 dark:hover:bg-secondary/50"
          style={{ height: '51px' }}
        >
          <RowOverlayButton
            label={item.name}
            onClick={() => onRowClick?.(item)}
            onDoubleClick={() => onRowDoubleClick?.(item)}
          />
          {/* Name */}
          <div className="min-w-[160px] flex-1 flex items-center gap-1.5">
            <Icon className={cn('h-4 w-4 shrink-0', typeConfig.color)} />
            <span className="text-sm font-medium truncate text-gray-900 dark:text-foreground">
              {item.name}
            </span>
            {item.isStarred && (
              <Star className="h-3.5 w-3.5 text-yellow-400 fill-yellow-400 shrink-0" />
            )}
          </div>

          {/* Type */}
          <div className="w-[120px]">
            <span className="text-sm text-muted-foreground capitalize">{item.fileType}</span>
          </div>

          {/* Source */}
          {showSource && (
            <div className="w-[140px]">
              {item.sourceLabel && (
                <span className={cn('-translate-y-[1.5px]', driveLabelClass, badgeClass)}>
                  {item.sourceLabel}
                </span>
              )}
            </div>
          )}

          {/* Size */}
          <div className="w-[100px]">
            <span className="text-sm font-mono text-muted-foreground tabular-nums">
              {item.fileSize ? formatFileSize(item.fileSize) : '—'}
            </span>
          </div>

          {/* Modified */}
          <div className="w-[130px]">
            <span className="text-sm font-mono text-muted-foreground">
              {item.createdAt ? formatDate(item.createdAt) : ''}
            </span>
          </div>

          {/* Actions */}
          <div className="w-[40px] flex items-center justify-center">{actionsMenu}</div>
        </div>
      );
    },
    [onRowClick, onRowDoubleClick, renderRowMenu, showSource, isCompact, st],
  );

  return (
    // `min-w-0` so a flex parent can shrink this box below the table's natural
    // width (the compact layout depends on getting the real, narrow width).
    <div ref={containerRef} className="min-w-0 w-full">
      <EntityList<FileListItem>
        items={sortedItems}
        isLoading={isLoading ?? false}
        error={error ?? null}
        filters={[]}
        // The column header only makes sense for the table layout; the compact
        // rows carry their size/date inline.
        headerColumns={isCompact ? undefined : headerColumns}
        renderRow={renderRow}
        searchFields={['name']}
        searchPlaceholder={searchPlaceholder}
        sortState={sortState}
        onSort={handleSort}
        actionButtons={actionButtons}
        emptyState={emptyState}
        noResultsState={noResultsState}
      />
    </div>
  );
}

/** Maps a MIME content-type to a `fileTypeIcons` category key. */
export function fileCategoryFromContentType(contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.includes('pdf')) return 'pdf';
  if (/zip|rar|7z|gzip|tar/.test(ct)) return 'archive';
  if (/sheet|excel|csv/.test(ct)) return 'spreadsheet';
  if (/presentation|powerpoint/.test(ct)) return 'presentation';
  if (/word|document|text|rtf/.test(ct)) return 'document';
  return 'file';
}
