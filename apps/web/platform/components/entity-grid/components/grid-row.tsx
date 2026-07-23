
import React from 'react';
import { useGridContext } from '../context';
import { useCellSelectionActions, useCellSelectionState } from '../cell-selection-context';
import { GridCell } from './grid-cell';
import { cn } from '@/lib/utils';

interface GridRowProps<TEntity> {
  entity: TEntity;
  rowIndex?: number;
}

export function GridRow<TEntity>({ entity, rowIndex }: GridRowProps<TEntity>) {
  const { config, state, getVisibleColumns, getEntityWithOptimisticUpdates } =
    useGridContext<TEntity>();
  // Stable references — these never change identity, so subscribing to them
  // doesn't drag the row through a re-render every time the selection moves.
  const { startSelection, extendSelection } = useCellSelectionActions();

  const { columnWidths, selectedRows, openPopover } = state;
  const visibleColumns = getVisibleColumns();
  const entityId = config.getEntityId(entity);
  const optimisticEntity = getEntityWithOptimisticUpdates(entity);
  const isSelected = selectedRows.has(entityId);
  const rowH = config.fillViewport ? 21 : 40;
  // GridRow receives a 1-based rowIndex (used for the row-number column);
  // for the cell-selection math we want the entity's 0-based slot in
  // filteredEntities so it lines up with `entities[row]` in the provider.
  const selectionRow = (rowIndex ?? 1) - 1;

  return (
    <tr
      data-testid="entity-grid-row"
      data-entity-id={entityId}
      className={cn(
        'group border-b border-border',
        isSelected && 'bg-blue-50 dark:bg-blue-500/10'
      )}
      style={{ height: `${rowH}px` }}
    >
      {/* Row number */}
      {config.showRowNumbers && (
        <td
          className="border-r border-border bg-muted/30 text-center text-xs text-muted-foreground select-none"
          style={{ width: 46, height: rowH, padding: 0 }}
        >
          {rowIndex}
        </td>
      )}

      {visibleColumns.map((column, index) => {
        const isCellPopoverOpen =
          openPopover?.rowId === entityId && openPopover?.fieldId === column.id;
        return (
          <SelectableCell
            key={column.id}
            row={selectionRow}
            col={index}
            rowH={rowH}
            isCellPopoverOpen={isCellPopoverOpen}
            isRowSelected={isSelected}
            onMouseDown={(e) => {
              // Left button only — leave context-menu / middle-click alone.
              if (e.button !== 0) return;
              // We deliberately DON'T filter interactive children any more.
              // Most data cells render their content inside <button>/<input>
              // popover triggers, so filtering by tag name made the
              // selection silently fail on date/select/checkbox/etc cells.
              // Now selection always engages on mousedown; the inner
              // button/input still receives its own event after this
              // handler runs (we don't preventDefault or stopPropagation),
              // so popovers / inline editors keep opening as before.
              //
              // The two exceptions are real text-editing surfaces — letting
              // those fall through would steal focus from an in-progress
              // edit. We only short-circuit there.
              const target = e.target as HTMLElement;
              if (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable
              ) {
                return;
              }
              startSelection({ row: selectionRow, col: index });
            }}
            onMouseEnter={() => extendSelection({ row: selectionRow, col: index })}
          >
            <GridCell
              entity={optimisticEntity}
              column={column}
              isFirstColumn={index === 0}
            />
          </SelectableCell>
        );
      })}
      {/* Empty cells for spreadsheet mode or spacer for normal mode */}
      {/* (SelectableCell defined below the row component) */}
      {config.fillViewport ? (
        Array.from({ length: 8 }).map((_, i) => (
          <td key={`empty-${i}`} className="border-r border-border" style={{ width: 100, height: `${rowH}px`, padding: 0 }} />
        ))
      ) : (
        <>
          {config.allowCustomColumns !== false && (
            <td style={{ height: `${rowH}px`, padding: 0 }} />
          )}
          <td style={{ height: `${rowH}px`, padding: 0 }} />
        </>
      )}
    </tr>
  );
}

interface SelectableCellProps {
  row: number;
  col: number;
  rowH: number;
  isCellPopoverOpen: boolean;
  isRowSelected: boolean;
  onMouseDown: React.MouseEventHandler<HTMLTableCellElement>;
  onMouseEnter: React.MouseEventHandler<HTMLTableCellElement>;
  children: React.ReactNode;
}

/**
 * One <td> with its own subscription to the cell-selection store. Pulled
 * out as a component so each cell can call `useCellSelectionState` and
 * React's `useSyncExternalStore` will only re-render the cells whose
 * state actually flipped on a given mousemove — instead of re-rendering
 * every cell in the table on every drag pixel.
 *
 * The visual treatment mirrors Attio's data table:
 *   • cells inside the range: a very light blue fill
 *   • outer perimeter of the range: a 2px blue outline (per-edge)
 *   • anchor cell (the click origin): white background and a full 2px
 *     blue border on every side, so it pops as the "active" cell within
 *     the rectangle
 *
 * Borders are drawn with `inset` `box-shadow`s rather than CSS `border`s
 * so they don't fight the table's `border-collapse: collapse` neighbour
 * borders and never thicken at the corners.
 */
const SELECTION_BORDER = '#3b82f6'; // tailwind blue-500
const SELECTION_BORDER_PX = 1;

const SelectableCell = React.memo(function SelectableCell({
  row,
  col,
  rowH,
  isCellPopoverOpen,
  isRowSelected,
  onMouseDown,
  onMouseEnter,
  children,
}: SelectableCellProps) {
  const state = useCellSelectionState(row, col);
  const isSelected = (state & 1) !== 0;
  const isAnchor = (state & 2) !== 0;
  const isTop = (state & 4) !== 0;
  const isBottom = (state & 8) !== 0;
  const isLeft = (state & 16) !== 0;
  const isRight = (state & 32) !== 0;

  const shadows: string[] = [];
  // Outer-edge borders for cells on the perimeter of the range.
  if (isTop) shadows.push(`inset 0 ${SELECTION_BORDER_PX}px 0 0 ${SELECTION_BORDER}`);
  if (isBottom) shadows.push(`inset 0 -${SELECTION_BORDER_PX}px 0 0 ${SELECTION_BORDER}`);
  if (isLeft) shadows.push(`inset ${SELECTION_BORDER_PX}px 0 0 0 ${SELECTION_BORDER}`);
  if (isRight) shadows.push(`inset -${SELECTION_BORDER_PX}px 0 0 0 ${SELECTION_BORDER}`);
  // Anchor cell — full ring on all four sides, even the ones that aren't
  // on the perimeter (so the active cell stands out within the range).
  if (isAnchor) {
    if (!isTop) shadows.push(`inset 0 ${SELECTION_BORDER_PX}px 0 0 ${SELECTION_BORDER}`);
    if (!isBottom) shadows.push(`inset 0 -${SELECTION_BORDER_PX}px 0 0 ${SELECTION_BORDER}`);
    if (!isLeft) shadows.push(`inset ${SELECTION_BORDER_PX}px 0 0 0 ${SELECTION_BORDER}`);
    if (!isRight) shadows.push(`inset -${SELECTION_BORDER_PX}px 0 0 0 ${SELECTION_BORDER}`);
  }

  return (
    <td
      data-grid-cell="1"
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      className={cn(
        'border-r border-border relative',
        // Background fill (no transition — selection feedback should be instant):
        //  - anchor → white (matches Attio's "active cell" treatment)
        //  - cell-range selected (non-anchor) → light blue tint
        //  - row selected → keep transparent so the row's blue shows through;
        //    on hover, deepen to blue-100 instead of falling back to gray
        //  - otherwise fall back to the regular per-row hover/popover bg
        isAnchor
          ? 'bg-background'
          : isSelected
          ? 'bg-blue-50 dark:bg-blue-500/10'
          : isCellPopoverOpen
          ? 'bg-muted/50'
          : isRowSelected
          ? 'hover:bg-blue-100 dark:hover:bg-blue-500/20'
          : 'hover:bg-muted/50',
      )}
      style={{
        height: `${rowH}px`,
        padding: 0,
        boxShadow: shadows.length ? shadows.join(', ') : undefined,
      }}
    >
      {children}
    </td>
  );
});
