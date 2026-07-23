
import React, { useRef, useState, useEffect } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useGridContext } from '../context';
import { CellSelectionProvider } from '../cell-selection-context';
import { GridHeader } from './grid-header';
import { GridRow } from './grid-row';
import { GridFooter } from './grid-footer';
import { EmptyStateIllustration } from '@/components/entity-list';
import { Button } from '@weldsuite/ui/components/button';

interface GridTableProps {
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function GridTable({ onLoadMore, hasMore, isFetchingMore }: GridTableProps) {
  const { config, filteredEntities, calculateTableWidth, getVisibleColumns, actions } = useGridContext();
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const [fillerRowCount, setFillerRowCount] = useState(50);

  // Infinite scroll via IntersectionObserver â€” fires even when content doesn't overflow.
  useEffect(() => {
    if (!onLoadMore || !hasMore || !loadMoreSentinelRef.current || !tableScrollRef.current) return;
    const sentinel = loadMoreSentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isFetchingMore) {
          onLoadMore();
        }
      },
      { root: tableScrollRef.current, rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, isFetchingMore, filteredEntities.length]);

  const isSpreadsheet = config.fillViewport;
  const ROW_HEIGHT = isSpreadsheet ? 21 : 40;
  const HEADER_HEIGHT = isSpreadsheet ? 21 : 40;

  // Calculate filler rows to fill the viewport
  useEffect(() => {
    if (!config.fillViewport || !tableScrollRef.current) return;

    const updateFillerCount = () => {
      if (!tableScrollRef.current) return;
      const viewportHeight = tableScrollRef.current.clientHeight;
      const dataRowsHeight = filteredEntities.length * ROW_HEIGHT;
      const availableHeight = viewportHeight - HEADER_HEIGHT;
      const minEmptyRows = Math.max(0, Math.ceil((availableHeight - dataRowsHeight) / ROW_HEIGHT));
      // Always show at least 20 extra empty rows beyond the viewport
      setFillerRowCount(Math.max(minEmptyRows, 20));
    };

    updateFillerCount();
    const observer = new ResizeObserver(updateFillerCount);
    observer.observe(tableScrollRef.current);
    return () => observer.disconnect();
  }, [config.fillViewport, filteredEntities.length]);

  const visibleColumns = getVisibleColumns();
  const showRowNumbers = config.showRowNumbers;
  const isEmpty = filteredEntities.length === 0 && !isFetchingMore && !config.fillViewport;
  const entityNameLower = config.entityName.toLowerCase();
  const entityNamePluralLower = (config.entityNamePlural || `${config.entityName}s`).toLowerCase();

  if (isEmpty) {
    return (
      <div
        ref={tableScrollRef}
        className="flex-1 bg-background min-h-0 flex flex-col"
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: 'fixed',
            width: '100%',
            minWidth: `${calculateTableWidth() + (showRowNumbers ? 46 : 0)}px`,
          }}
        >
          <GridHeader />
        </table>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
          <EmptyStateIllustration>
            <svg width="140" height="100" viewBox="0 0 140 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="8" y="8" width="124" height="80" className="fill-white dark:fill-white/[0.03] stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="8" y1="24" x2="132" y2="24" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="8" y1="40" x2="132" y2="40" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="8" y1="56" x2="132" y2="56" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="8" y1="72" x2="132" y2="72" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="39" y1="8" x2="39" y2="88" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="70" y1="8" x2="70" y2="88" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
              <line x1="101" y1="8" x2="101" y2="88" className="stroke-gray-200/90 dark:stroke-white/15" strokeWidth="0.75" />
            </svg>
          </EmptyStateIllustration>
          <h3 className="text-[15px] font-semibold text-foreground mb-1.5">
            No {entityNamePluralLower} yet
          </h3>
          <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed mb-5">
            Add your first {entityNameLower} to get started.
          </p>
          {actions.onCreateEntity && (
            <Button
              onClick={actions.onCreateEntity}
              className="h-8 text-sm px-3 gap-1.5 shadow-none"
            >
              <Plus className="h-4 w-4" />
              New {entityNameLower}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <CellSelectionProvider entities={filteredEntities}>
    <div
      ref={tableScrollRef}
      className="flex-1 bg-background min-h-0 scroll-smooth md:scroll-auto flex flex-col [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar:horizontal]:h-0 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-track]:bg-transparent"
      style={{
        overflowX: 'auto',
        overflowY: 'auto',
        scrollbarGutter: 'stable',
      }}
    >
      <table
        className="border-collapse flex-shrink-0 select-none"
        style={{
          tableLayout: 'fixed',
          width: isSpreadsheet ? `${calculateTableWidth() + (showRowNumbers ? 46 : 0) + 8 * 100}px` : '100%',
          minWidth: isSpreadsheet ? undefined : `${calculateTableWidth() + (showRowNumbers ? 46 : 0)}px`,
        }}
      >
        <GridHeader />
        <tbody className="bg-background">
          {filteredEntities.map((entity, index) => (
            <GridRow key={config.getEntityId(entity)} entity={entity} rowIndex={index + 1} />
          ))}

          {/* Empty filler rows for spreadsheet mode */}
          {config.fillViewport && Array.from({ length: fillerRowCount }).map((_, i) => {
            const rowNum = filteredEntities.length + i + 1;
            return (
              <tr key={`empty-${i}`} className="border-b border-border" style={{ height: `${ROW_HEIGHT}px` }}>
                {showRowNumbers && (
                  <td
                    className="border-r border-border bg-muted/30 text-center text-xs text-muted-foreground select-none"
                    style={{ width: 46, height: ROW_HEIGHT, padding: 0 }}
                  >
                    {rowNum}
                  </td>
                )}
                {visibleColumns.map((col) => (
                  <td
                    key={col.id}
                    className="border-r border-border cursor-cell"
                    style={{ height: ROW_HEIGHT, padding: 0 }}
                    onClick={() => actions.onCreateEntity?.()}
                  />
                ))}
                {/* Extra empty columns matching header */}
                {Array.from({ length: 8 }).map((_, j) => (
                  <td key={`empty-col-${j}`} className="border-r border-border" style={{ width: 100, height: ROW_HEIGHT, padding: 0 }} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {onLoadMore && hasMore && <div ref={loadMoreSentinelRef} aria-hidden className="h-0 w-full flex-shrink-0" />}
      {isFetchingMore && (
        <div className="flex items-center justify-center py-4 flex-shrink-0">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {/* Vertical spacer â€” when there aren't enough data rows to fill the
          scroll container, this expands to push the calculation footer down
          to the bottom of the visible area. With many rows it collapses to
          0 height and the footer (sticky bottom-0) hovers over the data as
          before. */}
      <div className="flex-1 min-h-0" />
      <GridFooter />
    </div>
    </CellSelectionProvider>
  );
}
