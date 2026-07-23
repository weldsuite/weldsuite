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

import { useCallback, useMemo, useState, type ReactNode } from 'react';
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
import {
  fileTypeIcons,
  sourceBadgeStyles,
  driveLabelClass,
  formatFileSize,
  formatDate,
} from '@/app/welddrive/components/drive-file-card';

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
}: FileListViewProps) {
  const { t } = useI18n();
  const [sortState, setSortState] = useState<SortState | null>(null);

  const headerColumns: HeaderColumn[] = useMemo(() => {
    const cols: HeaderColumn[] = [
      { id: 'name', header: t.welddrive.page.columns.name, width: 'min-w-[160px] flex-1', sortable: true },
      { id: 'fileType', header: t.welddrive.page.columns.type, width: 'w-[120px]', sortable: true },
    ];
    if (showSource) {
      cols.push({ id: 'source', header: t.welddrive.page.columns.source, width: 'w-[140px]', sortable: true });
    }
    cols.push({ id: 'fileSize', header: t.welddrive.page.columns.size, width: 'w-[100px]', sortable: true });
    cols.push({ id: 'createdAt', header: t.welddrive.page.columns.modified, width: 'w-[130px]', sortable: true });
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

      return (
        <div
          key={item.id}
          onClick={() => onRowClick?.(item)}
          onDoubleClick={() => onRowDoubleClick?.(item)}
          className="flex items-center gap-4 px-4 cursor-pointer border-b border-gray-200/70 dark:border-border group transition-colors hover:bg-gray-50 dark:hover:bg-secondary/50"
          style={{ height: '51px' }}
        >
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
          <div className="w-[40px] flex items-center justify-center">
            {renderRowMenu && (
              <div
                className="opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="p-1 rounded-md hover:bg-muted">
                      <MoreVertical className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52" sideOffset={4}>
                    {renderRowMenu(item)}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </div>
      );
    },
    [onRowClick, onRowDoubleClick, renderRowMenu, showSource],
  );

  return (
    <EntityList<FileListItem>
      items={sortedItems}
      isLoading={isLoading ?? false}
      error={error ?? null}
      filters={[]}
      headerColumns={headerColumns}
      renderRow={renderRow}
      searchFields={['name']}
      searchPlaceholder={searchPlaceholder}
      sortState={sortState}
      onSort={handleSort}
      actionButtons={actionButtons}
      emptyState={emptyState}
      noResultsState={noResultsState}
    />
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
