
import React from 'react';
import { useGridContext } from '../context';
import { useCellSelectionActions, useCellSelectionState } from '../cell-selection-context';
import { GridCell } from './grid-cell';
import { cn } from '@/lib/utils';
import { SPREADSHEET_EXTRA_COLUMNS } from '../spreadsheet';

interface GridRowProps<TEntity> {
  entity: TEntity;
  rowIndex?: number;
}

export function GridRow<TEntity>({ entity, rowIndex }: Readonly<GridRowProps<TEntity>>) {
  const { config, state, getVisibleColumns, getEntityWithOptimisticUpdates } =
    useGridContext<TEntity>();
  // Stable references — these never change identity, so subscribing to them
  // doesn't drag the row through a re-render every time the selection moves.
  const { startSelection, extendSelection } = useCellSelectionActions();

  const { selectedRows, openPopover } = state;
  const visibleColumns = getVisibleColumns();
  const entityId = config.getEntityId(entity);
  const optimisticEntity = getEntityWithOptimisticUpdates(entity);
  const isSelected = selectedRows.has(entityId);
  const rowH = config.fillViewport ? 21 : 40;
  // GridRow receives a 1-based rowIndex (used for the row-number column);
  // for the cell-selection math we want the entity's 0-based slot in
  // filteredEntities so it lines up with `entities[row]` in the provider.
  const selectionRow = (rowIndex ?? 1) - 1;

  const selectedLines = isSelected ? selectedLineClass(selectionRow) : undefined;

  return (
    <tr
      data-testid="entity-grid-row"
      data-entity-id={entityId}
      className={cn(
        'group border-b border-border',
        isSelected && cn('bg-blue-50 dark:bg-blue-500/10', SELECTED_LINE_COLOR)
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
        SPREADSHEET_EXTRA_COLUMNS.map((slot) => (
          <td key={`empty-${slot}`} className={cn('border-r border-border', selectedLines)} style={{ width: 100, height: `${rowH}px`, padding: 0 }} />
        ))
      ) : (
        <>
          {config.allowCustomColumns !== false && (
            <td className={selectedLines} style={{ height: `${rowH}px`, padding: 0 }} />
          )}
          <td className={selectedLines} style={{ height: `${rowH}px`, padding: 0 }} />
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
 * Borders are drawn by an overlay laid over the cell's grid lines rather
 * than CSS `border`s on the `<td>`, so the outline surrounds the whole cell
 * without fighting the table's `border-collapse: collapse` neighbour borders.
 */
const SELECTION_BORDER = 'rgb(59 130 246 / 0.7)'; // tailwind blue-500, softened
const SELECTION_BORDER_PX = 1;

const SEL_SELECTED = 1;
const SEL_ANCHOR = 2;
const SEL_TOP = 4;
const SEL_BOTTOM = 8;
const SEL_LEFT = 16;
const SEL_RIGHT = 32;

/**
 * Position and per-edge border widths of the selection outline, or null when
 * the cell has none. The overlay extends one pixel past the cell so it sits on
 * the surrounding grid lines; the first row and column stay inside the cell,
 * where the line would fall under the sticky header or outside the table.
 */
function selectionOutlineStyle(state: number, row: number, col: number): React.CSSProperties | null {
  // Anchor cell — full ring on all four sides, even the ones that aren't on
  // the perimeter (so the active cell stands out within the range).
  const isAnchor = (state & SEL_ANCHOR) !== 0;
  const width = (flag: number) => (isAnchor || (state & flag) !== 0 ? SELECTION_BORDER_PX : 0);
  const top = width(SEL_TOP);
  const right = width(SEL_RIGHT);
  const bottom = width(SEL_BOTTOM);
  const left = width(SEL_LEFT);
  if (!top && !right && !bottom && !left) return null;
  return {
    top: row === 0 ? 0 : -SELECTION_BORDER_PX,
    right: -SELECTION_BORDER_PX,
    bottom: -SELECTION_BORDER_PX,
    left: col === 0 ? 0 : -SELECTION_BORDER_PX,
    borderStyle: 'solid',
    borderColor: SELECTION_BORDER,
    borderWidth: `${top}px ${right}px ${bottom}px ${left}px`,
  };
}

// Grid lines of a selected row or cell range: light blue, to go with the blue
// fill.
// Solid colours on purpose. A semi-transparent collapsed border renders at
// about half strength in the data cells and at full strength in the empty
// trailing cells, so the same line looked different across one row. The dark
// value is blue-300 at 12% over the selected row's fill, flattened.
const SELECTED_LINE_COLOR = 'border-blue-100 dark:border-[#2c3c55]';

/**
 * Line classes for a cell that is selected, through its row or as part of a
 * cell range. The horizontal lines are set on the cells, not only the row:
 * with collapsed borders the line above a row belongs to the row before it,
 * and only a cell's border outranks that, so this is what turns the top edge
 * of a selected block blue as well. The first row gets no top border, which
 * would add a line under the header. Around a cell range the outline overlay
 * covers the outermost lines, so only the lines inside the range show.
 */
function selectedLineClass(row: number): string {
  return cn(SELECTED_LINE_COLOR, 'border-b', row > 0 && 'border-t');
}

interface CellBackgroundState {
  isAnchor: boolean;
  isSelected: boolean;
  isCellPopoverOpen: boolean;
  isRowSelected: boolean;
}

function cellBackgroundClass({
  isAnchor,
  isSelected,
  isCellPopoverOpen,
  isRowSelected,
}: CellBackgroundState): string {
  if (isAnchor) return 'bg-background';
  if (isSelected) return 'bg-blue-50 dark:bg-blue-500/10';
  if (isCellPopoverOpen) return 'bg-muted/50';
  if (isRowSelected) return 'hover:bg-blue-100 dark:hover:bg-blue-500/20';
  return 'hover:bg-muted/50';
}

const SelectableCell = React.memo(function SelectableCell({
  row,
  col,
  rowH,
  isCellPopoverOpen,
  isRowSelected,
  onMouseDown,
  onMouseEnter,
  children,
}: Readonly<SelectableCellProps>) {
  const state = useCellSelectionState(row, col);
  const isSelected = (state & SEL_SELECTED) !== 0;
  const isAnchor = (state & SEL_ANCHOR) !== 0;
  const outlineStyle = selectionOutlineStyle(state, row, col);

  return (
    <td
      data-grid-cell="1"
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      className={cn(
        'border-r border-border relative',
        (isRowSelected || isSelected) && selectedLineClass(row),
        // Background fill (no transition — selection feedback should be instant):
        //  - anchor → white (matches Attio's "active cell" treatment)
        //  - cell-range selected (non-anchor) → light blue tint
        //  - row selected → keep transparent so the row's blue shows through;
        //    on hover, deepen to blue-100 instead of falling back to gray
        //  - otherwise fall back to the regular per-row hover/popover bg
        cellBackgroundClass({ isAnchor, isSelected, isCellPopoverOpen, isRowSelected }),
      )}
      style={{ height: `${rowH}px`, padding: 0 }}
    >
      {children}
      {outlineStyle && (
        <span aria-hidden="true" className="pointer-events-none absolute z-[2]" style={outlineStyle} />
      )}
    </td>
  );
});
