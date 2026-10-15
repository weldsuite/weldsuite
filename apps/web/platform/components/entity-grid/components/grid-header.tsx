
import React, { useState } from 'react';
import {
  Plus,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  EyeOff,
  Trash2,
  Play,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useGridContext } from '../context';
import { SPREADSHEET_EXTRA_COLUMNS } from '../spreadsheet';
import { AddColumnMenu } from './add-column-menu';

function colIndexToLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCodePoint(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function headerCellLayoutClass(fillViewport: boolean | undefined, index: number): string {
  if (fillViewport) return 'justify-center px-3';
  return index === 0 ? 'pl-5 pr-3 gap-3' : 'px-3 gap-1.5';
}

/**
 * How far the column-menu trigger has to reach past its own box to cover the
 * whole header cell: out to the cell edges, and under the select-all checkbox
 * and the enrich button when the cell has them. Mirrors the padding and gaps
 * of `headerCellLayoutClass` (px-3 = 12, pl-5 = 20, gap-3 = 12, gap-1.5 = 6),
 * the 16px checkbox and the 24px enrich button; keep them in step.
 */
function headerTriggerInsets(opts: {
  fillViewport: boolean | undefined;
  isFirst: boolean;
  hasCheckbox: boolean;
  hasEnrich: boolean;
}): { left: number; right: number } {
  if (opts.fillViewport) return { left: 12, right: 12 };
  const gap = opts.isFirst ? 12 : 6;
  let left = 12;
  if (opts.isFirst) left = opts.hasCheckbox ? 20 + 16 + gap : 20;
  return { left, right: opts.hasEnrich ? 12 + 24 + gap : 12 };
}

export function GridHeader() {
  const t = useTranslations();
  const {
    config,
    state,
    filteredEntities,
    getVisibleColumns,
    setSelectedRows,
    handleSort,
    handleHideColumn,
    handleMoveColumn,
    handleColumnResize,
    deleteColumn,
  } = useGridContext();

  const { selectedRows, columnWidths, columns } = state;
  const visibleColumns = getVisibleColumns();
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [openColumnMenu, setOpenColumnMenu] = useState<string | null>(null);
  // Track hover on the Add-column cell so the trailing-spacer cell can mirror
  // the same highlight, making the entire right-hand strip a single hoverable
  // surface (no visible vertical divider between the Add cell and the spacer).
  const [addColumnHover, setAddColumnHover] = useState(false);
  const addColumnHighlighted = addColumnOpen || addColumnHover;

  // Anything for the "Add column" picker (AddColumnMenu) to offer
  const hasHiddenColumns = columns.some((c) => c.visible === false);
  const availableEnrichFields = config.availableEnrichFields ?? [];
  const showAddButton = hasHiddenColumns || availableEnrichFields.length > 0 || !!config.onCreateAttribute;

  // Column resize handling
  const handleResizePointerDown = (e: React.PointerEvent, fieldId: string) => {
    e.preventDefault();
    const startX = e.clientX;
    const column = visibleColumns.find((c) => c.id === fieldId);
    const startWidth = columnWidths[fieldId] || column?.width || 150;
    // Pointer events do not suppress the browser's text selection the way
    // mousedown's preventDefault does, so block it for the length of the drag.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const diff = moveEvent.clientX - startX;
      const newWidth = Math.max(80, startWidth + diff);
      handleColumnResize(fieldId, newWidth);
    };

    const handlePointerUp = () => {
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);
  };

  // Inset box-shadow gives the sticky <thead> a stable 1px bottom rule.
  // A real `border-bottom` collapses with the first row's top edge under
  // `border-collapse: collapse`, and the merged border ends up on the row
  // (not the sticky header) — so when the user scrolls vertically the line
  // disappears together with the row that just scrolled past. The shadow
  // is painted inside the cell and is unaffected by border collapsing.
  const headerShadow = 'inset 0 -1px 0 var(--border)';

  return (
    <thead className="bg-background sticky top-0 z-10">
      <tr style={{ height: config.fillViewport ? '21px' : '40px' }}>
        {/* Row number header */}
        {config.showRowNumbers && (
          <th
            className="border-r border-border bg-muted/30"
            style={{ width: 46, height: config.fillViewport ? 21 : 40, padding: 0, boxShadow: headerShadow }}
          />
        )}
        {visibleColumns.map((column, index) => {
          const hasCheckbox = !config.fillViewport && index === 0 && config.enableRowSelection !== false;
          const triggerInsets = headerTriggerInsets({
            fillViewport: config.fillViewport,
            isFirst: index === 0,
            hasCheckbox,
            hasEnrich: !!(column.isEnrichField && column.onEnrichAll),
          });
          return (
          <th
            key={column.id}
            className={cn(
              "border-r border-border font-medium text-sm text-foreground/80 bg-background relative",
              config.fillViewport ? "text-center" : "text-left"
            )}
            style={{
              width: columnWidths[column.id] || column.width,
              minWidth: 80,
              height: config.fillViewport ? '21px' : '40px',
              padding: 0,
              boxShadow: headerShadow,
            }}
          >
            <div
              className={cn(
                'group w-full h-full flex items-center transition-colors',
                openColumnMenu === column.id ? 'bg-muted/50' : 'hover:bg-muted/50',
                headerCellLayoutClass(config.fillViewport, index)
              )}
              style={{ height: config.fillViewport ? '21px' : '40px' }}
            >
              {/* Checkbox for first column (non-spreadsheet mode only) */}
              {hasCheckbox && (
                <Checkbox
                  checked={
                    selectedRows.size === filteredEntities.length &&
                    filteredEntities.length > 0
                  }
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedRows(
                        new Set(filteredEntities.map((e) => config.getEntityId(e)))
                      );
                    } else {
                      setSelectedRows(new Set());
                    }
                  }}
                  className="relative z-[1] flex-shrink-0 rounded-[5px]"
                />
              )}

              {/* Column header with dropdown. The trigger spans the whole
                  cell, so the checkbox and enrich button sit on top of it. */}
              <Popover
                open={openColumnMenu === column.id}
                onOpenChange={(open) => setOpenColumnMenu(open ? column.id : null)}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className={cn(
                      // No hover fill of its own: the cell behind it supplies
                      // the same `muted/50` hover the body cells use.
                      "h-full flex items-center transition-colors gap-1.5 rounded-none hover:bg-transparent dark:hover:bg-transparent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      config.fillViewport ? "flex-1 justify-center" : "flex-1 justify-start text-left"
                    )}
                    style={{
                      height: config.fillViewport ? '21px' : '40px',
                      overflow: 'hidden',
                      marginLeft: -triggerInsets.left,
                      paddingLeft: triggerInsets.left,
                      marginRight: -triggerInsets.right,
                      paddingRight: triggerInsets.right,
                    }}
                  >
                    {!config.fillViewport && index !== 0 && column.iconUrl ? (
                      <img src={column.iconUrl} alt="" className="h-3.5 w-3.5 flex-shrink-0 object-contain" />
                    ) : (
                      !config.fillViewport && index !== 0 &&
                      column.icon &&
                      React.createElement(column.icon, {
                        className: 'h-3.5 w-3.5 flex-shrink-0',
                      })
                    )}
                    <span className="text-[13px] truncate">
                      {config.fillViewport ? colIndexToLetter(index) : column.name}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-0" align="start" alignOffset={triggerInsets.left - 9}>
                  <Command>
                    <CommandList>
                      <CommandGroup className="px-1 py-1">
                        <CommandItem
                          onSelect={() => {
                            handleSort(column.id, 'asc');
                            toast.success(t('sweep.entities.sortedAscending'));
                          }}
                        >
                          <ArrowUp />
                          <span>{t('sweep.entities.sortAscending')}</span>
                        </CommandItem>
                        <CommandItem
                          onSelect={() => {
                            handleSort(column.id, 'desc');
                            toast.success(t('sweep.entities.sortedDescending'));
                          }}
                        >
                          <ArrowDown />
                          <span>{t('sweep.entities.sortDescending')}</span>
                        </CommandItem>
                      </CommandGroup>
                      <div className="h-px bg-gray-200 dark:bg-accent mx-1" />
                      <CommandGroup className="px-1 py-1">
                        <CommandItem
                          onSelect={() => {
                            handleMoveColumn(column.id, 'left');
                            toast.success(t('sweep.entities.columnMovedLeft'));
                          }}
                          disabled={index === 0}
                        >
                          <ArrowLeft />
                          <span>{t('sweep.entities.moveLeft')}</span>
                        </CommandItem>
                        <CommandItem
                          onSelect={() => {
                            handleMoveColumn(column.id, 'right');
                            toast.success(t('sweep.entities.columnMovedRight'));
                          }}
                          disabled={index === visibleColumns.length - 1}
                        >
                          <ArrowRight />
                          <span>{t('sweep.entities.moveRight')}</span>
                        </CommandItem>
                      </CommandGroup>
                      <div className="h-px bg-gray-200 dark:bg-accent mx-1" />
                      <CommandGroup className="px-1 py-1">
                        <CommandItem
                          onSelect={() => {
                            handleHideColumn(column.id);
                            toast.success(t('sweep.entities.columnHidden'));
                          }}
                        >
                          <EyeOff />
                          <span>{t('sweep.entities.hideFromView')}</span>
                        </CommandItem>
                      </CommandGroup>
                      {column.headerMenuItems && column.headerMenuItems.length > 0 && (
                        <>
                          <div className="h-px bg-gray-200 dark:bg-accent mx-1" />
                          <CommandGroup className="px-1 py-1">
                            {column.headerMenuItems.map((menuItem) => (
                              <CommandItem
                                key={menuItem.label}
                                onSelect={() => menuItem.onSelect()}
                                className={cn(
                                  menuItem.destructive &&
                                    'text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950 data-[selected=true]:bg-red-50 data-[selected=true]:text-red-600 dark:data-[selected=true]:bg-red-950 dark:data-[selected=true]:text-red-400',
                                )}
                              >
                                {menuItem.icon &&
                                  React.createElement(menuItem.icon, {
                                    className: menuItem.destructive ? 'text-red-600' : undefined,
                                  })}
                                <span>{menuItem.label}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </>
                      )}

                      {column.isCustom && (
                        <>
                          <div className="h-px bg-gray-200 dark:bg-accent mx-1" />
                          <CommandGroup className="px-1 py-1">
                            <CommandItem
                              onSelect={() => deleteColumn(column.id)}
                              className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950 data-[selected=true]:bg-red-50 data-[selected=true]:text-red-600 dark:data-[selected=true]:bg-red-950 dark:data-[selected=true]:text-red-400"
                            >
                              <Trash2 className="text-red-600" />
                              <span>{t('sweep.entities.deleteColumn')}</span>
                            </CommandItem>
                          </CommandGroup>
                        </>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {/* Enrich all button — visible on hover */}
              {column.isEnrichField && column.onEnrichAll && (
                <Tooltip disableHoverableContent>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        column.onEnrichAll!(filteredEntities);
                      }}
                      className="relative z-[1] flex-shrink-0 h-6 w-6 rounded-md border border-border text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-all hover:bg-muted hover:text-foreground"
                    >
                      <Play className="h-3 w-3 fill-current" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs pointer-events-none">
                    {t('sweep.entities.enrichAllRowsCredits', {
                      credits: filteredEntities.length * (column.creditCost || 0),
                    })}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            {/* Resize handle */}
            <div
              className="absolute right-0 top-0 w-1 h-full cursor-col-resize touch-none hover:bg-muted-foreground/50 bg-transparent transition-colors"
              onPointerDown={(e) => handleResizePointerDown(e, column.id)}
            />

            {/* Keeps the column separators the header's own colour while the
                grid is scrolled. The `border-r` above is a collapsed border,
                which the table paints at the header's un-stuck position: once
                scrolled it is gone, leaving a 1px slit between the header
                cells through which the body rows' own line shows (blue under
                selected rows). This strip sits behind the header cells'
                backgrounds and overhangs both edges, so only the slits show
                it, wherever the browser puts them. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -inset-x-2 -z-[1] bg-border" />
          </th>
          );
        })}

        {/* Spreadsheet mode: empty column headers extending to the right */}
        {config.fillViewport && config.onCreateAttribute ? (
          <>
            {SPREADSHEET_EXTRA_COLUMNS.map((slot) => {
              const letterIndex = visibleColumns.length + slot;
              return (
                <th
                  key={`empty-col-${slot}`}
                  className="bg-muted/30 border-r border-border cursor-pointer hover:bg-muted/60 transition-colors text-center text-[13px] font-medium text-muted-foreground"
                  style={{ width: 100, height: '21px', padding: 0, boxShadow: headerShadow }}
                  onClick={() => config.onCreateAttribute!()}
                >
                  {colIndexToLetter(letterIndex)}
                </th>
              );
            })}
          </>
        ) : (
          <>
            {/* Add column button (non-spreadsheet mode) — the cell is reserved
                whenever `allowCustomColumns` is on (so the column-width math
                matches the footer/body) but the actual `Add` button only
                renders when `showAddButton` is true (i.e. there's something to
                add). */}
            {config.allowCustomColumns !== false && (
              <th
                // The cell stays opaque: the highlight is laid over it by the
                // button, so a hovered header never shows the rows scrolling
                // underneath.
                className="bg-background relative"
                style={{ width: '140px', height: '40px', padding: 0, boxShadow: headerShadow }}
                onMouseEnter={() => showAddButton && setAddColumnHover(true)}
                onMouseLeave={() => setAddColumnHover(false)}
              >
                {showAddButton && (
                <Popover open={addColumnOpen} onOpenChange={setAddColumnOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className={cn(
                        // One fill for the whole Add zone: the same `muted/50`
                        // as the spacer cell beside it, in place of the
                        // button's own lighter hover.
                        "w-full h-full flex items-center justify-start px-3 gap-1.5 text-foreground/80 transition-colors rounded-none hover:bg-muted/50 dark:hover:bg-muted/50",
                        addColumnHighlighted && "bg-muted/50",
                      )}
                    >
                      <Plus className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="text-[13px] font-medium">{t('sweep.entities.add')}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[240px] p-0" align="start" alignOffset={2} collisionPadding={16}>
                    <AddColumnMenu onClose={() => setAddColumnOpen(false)} />
                  </PopoverContent>
                </Popover>
                )}
              </th>
            )}

            {/* Spacer cell — mirrors the Add cell's hover/click target so the
                entire right-hand strip is one big "Add column" zone (no
                visible border-r on the Add cell, shared bg highlight on
                hover, click anywhere opens the same popover). */}
            <th
              className={cn("bg-background", showAddButton && "cursor-pointer")}
              style={{ height: '40px', padding: 0, boxShadow: headerShadow }}
              onMouseEnter={() => showAddButton && setAddColumnHover(true)}
              onMouseLeave={() => setAddColumnHover(false)}
              onClick={() => showAddButton && setAddColumnOpen(true)}
            >
              <div
                className={cn(
                  "w-full transition-colors",
                  showAddButton && addColumnHighlighted && "bg-muted/50",
                )}
                style={{ height: '40px' }}
              />
            </th>
          </>
        )}
      </tr>
    </thead>
  );
}
