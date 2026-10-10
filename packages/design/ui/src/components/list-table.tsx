import * as React from 'react';
import { EllipsisVertical, XCircle } from 'lucide-react';

import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';

/**
 * A column definition in a `ListTable`.
 *
 * `cell` receives the full row and returns any React node — use it to embed
 * badges, icons, formatted dates, truncated text, etc. For simple cases where
 * the data is already a string, pass a plain `accessor` instead.
 *
 * `width` accepts: a pixel number (`120`), a Tailwind width class
 * (`'w-[180px]'`, `'flex-1'`), or a raw CSS size (`'30%'`). Undefined lets
 * the cell flex.
 */
export interface ListTableColumn<T> {
  id: string;
  header: React.ReactNode;
  width?: string | number;
  align?: 'left' | 'right' | 'center';
  cell?: (row: T, rowIndex: number) => React.ReactNode;
  accessor?: (row: T) => React.ReactNode;
  className?: string;
  hidden?: boolean;
}

/**
 * Splits rows into labeled sections under group-header rows. Each row lands in
 * the FIRST matching group. Rows matching no group fall into an "ungrouped"
 * bucket whose label comes from `ungroupedLabel` on the table.
 */
export interface ListTableGroup<T> {
  id: string;
  label: React.ReactNode;
  sortOrder?: number;
  filter: (row: T) => boolean;
  hideWhenEmpty?: boolean;
  renderCount?: (count: number) => React.ReactNode;
}

/**
 * Represents one item in the built-in row actions dropdown. For a fully custom
 * trailing cell, pass `actionsRenderer` to the table instead.
 */
export interface ListTableAction<T> {
  id: string;
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: (row: T) => void;
  hidden?: (row: T) => boolean;
  disabled?: (row: T) => boolean;
  separatorAbove?: boolean;
  variant?: 'default' | 'destructive';
}

export interface ListTableEmptyState {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: { label: React.ReactNode; onClick: () => void };
}

export interface ListTableNoResultsState {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClear?: () => void;
  clearLabel?: React.ReactNode;
}

export interface ListTableProps<T> {
  columns: ListTableColumn<T>[];
  data: T[];
  rowKey?: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /**
   * Accessible name for the row's click target when `onRowClick` is set.
   * Defaults to the text of the row's first visible column.
   */
  rowLabel?: (row: T) => string;
  actions?: ListTableAction<T>[];
  actionsRenderer?: (row: T) => React.ReactNode;

  /** Rich empty-state card shown when `data.length === 0`. */
  emptyState?: ListTableEmptyState;
  /** Short fallback message when no `emptyState` is supplied. */
  emptyMessage?: React.ReactNode;
  /** Shown when `data.length > 0` but the visible set (after groups/filter) is empty. */
  noResultsState?: ListTableNoResultsState;

  className?: string;
  /** Gap between columns — defaults to `gap-4`. */
  columnGap?: string;
  /** Extra px offset for sticky column/group headers (e.g. when the toolbar above is also sticky). */
  stickyOffset?: number;
  /** Apply dense row padding. */
  dense?: boolean;

  groups?: ListTableGroup<T>[];
  ungroupedLabel?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Width helpers
// ---------------------------------------------------------------------------

/**
 * Cells of a clickable row sit above the stretched row button but let pointer
 * events fall through to it, except on their own interactive content.
 */
const ROW_CELL_CLICK_THROUGH =
  'relative z-[1] pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_label]:pointer-events-auto [&_[role=button]]:pointer-events-auto [&_[role=checkbox]]:pointer-events-auto [&_[role=switch]]:pointer-events-auto [&_[role=combobox]]:pointer-events-auto [&_[role=link]]:pointer-events-auto';

function widthClass(width?: string | number): string | undefined {
  if (width === undefined) return 'flex-1';
  if (typeof width === 'number') return `w-[${width}px]`;
  return width; // 'w-[120px]', 'flex-1', '30%', etc.
}

function widthInlineStyle(width?: string | number): React.CSSProperties | undefined {
  if (typeof width === 'string' && !width.startsWith('w-') && !width.startsWith('flex')) {
    return { width };
  }
  return undefined;
}

function alignClass(align?: 'left' | 'right' | 'center'): string {
  switch (align) {
    case 'right':
      return 'text-right justify-end';
    case 'center':
      return 'text-center justify-center';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Row bucketing (groups)
// ---------------------------------------------------------------------------

interface IndexedRow<T> {
  row: T;
  idx: number;
}

interface ListTableBuckets<T> {
  ordered: Array<{ group: ListTableGroup<T>; rows: Array<IndexedRow<T>> }>;
  leftover: Array<IndexedRow<T>>;
}

function safeGroupFilter<T>(group: ListTableGroup<T>, row: T): boolean {
  try {
    return group.filter(row);
  } catch {
    return false;
  }
}

function partitionIntoBuckets<T>(
  groups: ListTableGroup<T>[] | undefined,
  data: T[],
): ListTableBuckets<T> | null {
  if (!groups || groups.length === 0) return null;
  const byId = new Map<string, { group: ListTableGroup<T>; rows: Array<IndexedRow<T>> }>();
  for (const g of groups) byId.set(g.id, { group: g, rows: [] });
  const leftover: Array<IndexedRow<T>> = [];

  data.forEach((row, idx) => {
    const match = groups.find((g) => safeGroupFilter(g, row));
    if (match) {
      byId.get(match.id)!.rows.push({ row, idx });
    } else {
      leftover.push({ row, idx });
    }
  });

  const ordered = [...groups]
    .map((g, i) => ({ group: g, sortOrder: g.sortOrder ?? i }))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ group }) => ({ group, rows: byId.get(group.id)!.rows }));

  return { ordered, leftover };
}

function bucketsAreEmpty<T>(buckets: ListTableBuckets<T> | null): boolean {
  if (buckets === null) return false;
  return buckets.ordered.every((b) => b.rows.length === 0) && buckets.leftover.length === 0;
}

// ---------------------------------------------------------------------------
// Empty + no-results blocks
// ---------------------------------------------------------------------------

function ListTableEmptyBlock({
  emptyState,
  emptyMessage,
}: Readonly<{
  emptyState?: ListTableEmptyState;
  emptyMessage: React.ReactNode;
}>) {
  if (!emptyState) {
    return <div className="text-center text-muted-foreground py-8">{emptyMessage}</div>;
  }
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16">
      {emptyState.icon}
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">
        {emptyState.title}
      </h3>
      {emptyState.description ? (
        <p className="text-sm text-muted-foreground mb-5 max-w-[320px] leading-relaxed whitespace-pre-line">
          {emptyState.description}
        </p>
      ) : null}
      {emptyState.action ? (
        <Button
          size="sm"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={emptyState.action.onClick}
        >
          {emptyState.action.label}
        </Button>
      ) : null}
    </div>
  );
}

function ListTableNoResultsBlock({ state }: Readonly<{ state: ListTableNoResultsState }>) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <XCircle className="h-8 w-8 text-muted-foreground mb-3" />
      <h3 className="text-sm font-medium text-foreground mb-1">{state.title}</h3>
      {state.description ? (
        <p className="text-sm text-muted-foreground mb-4">{state.description}</p>
      ) : null}
      {state.onClear ? (
        <Button variant="outline" size="sm" onClick={state.onClear}>
          {state.clearLabel ?? 'Clear filters'}
        </Button>
      ) : null}
    </div>
  );
}

function ListTableGroupedRows<T>({
  buckets,
  ungroupedLabel,
  stickyOffset,
  renderRow,
}: Readonly<{
  buckets: ListTableBuckets<T>;
  ungroupedLabel?: React.ReactNode;
  stickyOffset: number;
  renderRow: (row: T, idx: number) => React.ReactNode;
}>) {
  return (
    <>
      {buckets.ordered.map(({ group, rows }) => {
        const hide = rows.length === 0 && (group.hideWhenEmpty ?? true);
        if (hide) return null;
        return (
          <React.Fragment key={group.id}>
            <GroupHeaderRow
              label={group.label}
              count={rows.length}
              renderCount={group.renderCount}
              stickyOffset={stickyOffset + 35}
            />
            {rows.map(({ row, idx }) => renderRow(row, idx))}
          </React.Fragment>
        );
      })}
      {buckets.leftover.length > 0 ? (
        <React.Fragment key="__ungrouped">
          <GroupHeaderRow
            label={ungroupedLabel ?? 'Other'}
            count={buckets.leftover.length}
            stickyOffset={stickyOffset + 35}
          />
          {buckets.leftover.map(({ row, idx }) => renderRow(row, idx))}
        </React.Fragment>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Row-oriented list with sticky column headers, optional grouping, and a
 * configurable trailing actions dropdown. Visually matches the pattern used
 * by the `/weldcrm/call-intelligence` page: flex-based rows with border
 * separators, small uppercase muted column headers, sticky group headers
 * with count badges.
 */
export function ListTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  rowLabel,
  actions,
  actionsRenderer,
  emptyState,
  emptyMessage = 'No results',
  noResultsState,
  className,
  columnGap = 'gap-4',
  stickyOffset = 0,
  dense,
  groups,
  ungroupedLabel,
}: Readonly<ListTableProps<T>>) {
  const tableId = React.useId();
  const visibleColumns = columns.filter((c) => !c.hidden);
  const showActions = !!actionsRenderer || (actions && actions.length > 0);

  const resolveKey = React.useCallback(
    (row: T, idx: number): string => {
      if (rowKey) return rowKey(row, idx);
      const anyRow = row as unknown as { id?: string | number };
      return anyRow.id !== undefined ? String(anyRow.id) : String(idx);
    },
    [rowKey],
  );

  // ─── Row renderer ──────────────────────────────────────────────────────
  const renderRow = (row: T, idx: number) => {
    const key = resolveKey(row, idx);
    const firstCellId = `${tableId}-${key.replaceAll(/\s+/g, '_')}-first`;
    const rowLabelText = rowLabel?.(row);
    return (
    <div
      key={key}
      className={cn(
        'group relative flex items-center px-4 border-b border-border/70 transition-colors',
        dense ? 'py-2' : 'py-3',
        columnGap,
        onRowClick && 'hover:bg-muted/40',
      )}
    >
      {/* Stretched row button: sits behind the cells; cells let clicks fall
          through to it except on their own interactive content. */}
      {onRowClick ? (
        <button
          type="button"
          aria-label={rowLabelText}
          aria-labelledby={rowLabelText === undefined ? firstCellId : undefined}
          onClick={() => onRowClick(row)}
          className="absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      ) : null}
      {visibleColumns.map((col, colIdx) => {
        let content: React.ReactNode = null;
        if (col.cell) {
          content = col.cell(row, idx);
        } else if (col.accessor) {
          content = col.accessor(row);
        }
        return (
          <div
            key={col.id}
            id={colIdx === 0 ? firstCellId : undefined}
            className={cn(
              'min-w-0 flex items-center',
              onRowClick && ROW_CELL_CLICK_THROUGH,
              widthClass(col.width),
              alignClass(col.align),
              col.className,
            )}
            style={widthInlineStyle(col.width)}
          >
            {content}
          </div>
        );
      })}
      {showActions ? (
        <div className="relative z-[1] w-[40px] flex justify-end">
          {actionsRenderer ? (
            actionsRenderer(row)
          ) : (
            <ListTableRowActions row={row} actions={actions ?? []} />
          )}
        </div>
      ) : null}
    </div>
    );
  };

  // ─── Partition into buckets ────────────────────────────────────────────
  const buckets = React.useMemo(() => partitionIntoBuckets(groups, data), [groups, data]);

  // ─── Column header bar ────────────────────────────────────────────────
  const columnHeader = (
    <div
      className={cn(
        'flex items-center px-4 h-[35px] border-b border-border/70 sticky bg-background z-10',
        columnGap,
      )}
      style={{ top: stickyOffset }}
    >
      {visibleColumns.map((col) => (
        <div
          key={col.id}
          className={cn(
            'min-w-0 flex items-center',
            widthClass(col.width),
            alignClass(col.align),
            col.className,
          )}
          style={widthInlineStyle(col.width)}
        >
          <span className="text-xs font-medium text-muted-foreground">{col.header}</span>
        </div>
      ))}
      {showActions ? <div className="w-[40px]" /> : null}
    </div>
  );

  // ─── Empty + no-results states ────────────────────────────────────────
  const isEmpty = data.length === 0;
  const nothingToShow = bucketsAreEmpty(buckets);
  const showNoResultsBanner =
    !isEmpty && nothingToShow && !!noResultsState;

  let body: React.ReactNode;
  if (isEmpty) {
    body = <ListTableEmptyBlock emptyState={emptyState} emptyMessage={emptyMessage} />;
  } else if (showNoResultsBanner) {
    body = <ListTableNoResultsBlock state={noResultsState!} />;
  } else if (buckets) {
    body = (
      <ListTableGroupedRows
        buckets={buckets}
        ungroupedLabel={ungroupedLabel}
        stickyOffset={stickyOffset}
        renderRow={renderRow}
      />
    );
  } else {
    body = data.map((row, idx) => renderRow(row, idx));
  }

  return (
    <div className={cn('bg-background', className)}>
      {!isEmpty ? columnHeader : null}

      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group header — sticky, muted label with a small monospace count badge.
// Matches the EntityList visual exactly.
// ---------------------------------------------------------------------------

function GroupHeaderRow({
  label,
  count,
  renderCount,
  stickyOffset,
}: Readonly<{
  label: React.ReactNode;
  count: number;
  renderCount?: (count: number) => React.ReactNode;
  stickyOffset: number;
}>) {
  return (
    <div
      className="relative flex items-center gap-2 px-4 h-8 bg-background border-b border-border/70 sticky z-[9]"
      style={{ top: stickyOffset }}
    >
      <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
      <span className="relative text-xs font-medium text-muted-foreground">{label}</span>
      {renderCount ? (
        renderCount(count)
      ) : (
        <span className="relative text-[10px] font-mono text-muted-foreground bg-muted border border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px] -translate-y-px">
          <span className="translate-y-[1px]">{count}</span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Built-in row actions dropdown
// ---------------------------------------------------------------------------

function ListTableRowActions<T>({
  row,
  actions,
}: Readonly<{
  row: T;
  actions: ListTableAction<T>[];
}>) {
  const visible = actions.filter((a) => !a.hidden?.(row));
  if (visible.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
          aria-label="Open row actions"
        >
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {visible.map((action) => {
          const Icon = action.icon;
          const isDisabled = action.disabled ? action.disabled(row) : false;
          return (
            <React.Fragment key={action.id}>
              {action.separatorAbove ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={isDisabled}
                className={cn(
                  action.variant === 'destructive' &&
                    'text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400',
                )}
                onClick={() => action.onClick(row)}
              >
                {Icon ? (
                  <Icon
                    className={cn(
                      'mr-0.5 h-4 w-4',
                      action.variant === 'destructive' &&
                        'text-red-600 dark:text-red-400',
                    )}
                  />
                ) : null}
                {action.label}
              </DropdownMenuItem>
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
