
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
  CommandEmpty,
  CommandGroup,
  CommandInput,
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

function colIndexToLetter(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
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
    showColumn,
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

  // Hidden columns available for the "Add column" picker
  const hiddenBuiltInColumns = columns.filter((c) => c.visible === false && !c.isCustom);
  const hiddenCustomColumns = columns.filter((c) => c.visible === false && c.isCustom && !c.isEnrichField);
  const hiddenEnrichColumns = columns.filter((c) => c.visible === false && c.isEnrichField);
  const availableEnrichFields = config.availableEnrichFields ?? [];
  const hasHiddenColumns = hiddenBuiltInColumns.length > 0 || hiddenCustomColumns.length > 0 || hiddenEnrichColumns.length > 0;
  const showAddButton = hasHiddenColumns || availableEnrichFields.length > 0 || !!config.onCreateAttribute;

  // Column resize handling
  const handleMouseDown = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    const startX = e.clientX;
    const column = visibleColumns.find((c) => c.id === fieldId);
    const startWidth = columnWidths[fieldId] || column?.width || 150;

    const handleMouseMove = (e: MouseEvent) => {
      const diff = e.clientX - startX;
      const newWidth = Math.max(80, startWidth + diff);
      handleColumnResize(fieldId, newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
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
        {visibleColumns.map((column, index) => (
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
                config.fillViewport
                  ? 'justify-center px-3'
                  : index === 0 ? 'pl-5 pr-3 gap-3' : 'px-3 gap-1.5'
              )}
              style={{ height: config.fillViewport ? '21px' : '40px' }}
            >
              {/* Checkbox for first column (non-spreadsheet mode only) */}
              {!config.fillViewport && index === 0 && config.enableRowSelection !== false && (
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
                  className="flex-shrink-0 rounded-[5px]"
                />
              )}

              {/* Column header with dropdown */}
              <Popover
                open={openColumnMenu === column.id}
                onOpenChange={(open) => setOpenColumnMenu(open ? column.id : null)}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    className={cn(
                      "h-full flex items-center transition-colors gap-1.5 rounded-none",
                      config.fillViewport ? "justify-center" : "flex-1 text-left"
                    )}
                    style={{ height: config.fillViewport ? '21px' : '40px', overflow: 'hidden' }}
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
                <PopoverContent className="w-[200px] p-0" align="start" alignOffset={-9}>
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
                      className="flex-shrink-0 h-6 w-6 rounded-md border border-border text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-all hover:bg-muted hover:text-foreground"
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
              className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-muted-foreground/50 bg-transparent transition-colors"
              onMouseDown={(e) => handleMouseDown(e, column.id)}
            />
          </th>
        ))}

        {/* Spreadsheet mode: empty column headers extending to the right */}
        {config.fillViewport && config.onCreateAttribute ? (
          <>
            {Array.from({ length: 8 }).map((_, i) => {
              const letterIndex = visibleColumns.length + i;
              return (
                <th
                  key={`empty-col-${i}`}
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
                className={cn(
                  "bg-background relative transition-colors",
                  showAddButton && addColumnHighlighted && "bg-muted/50",
                )}
                style={{ width: '140px', height: '40px', padding: 0, boxShadow: headerShadow }}
                onMouseEnter={() => showAddButton && setAddColumnHover(true)}
                onMouseLeave={() => setAddColumnHover(false)}
              >
                {showAddButton && (
                <Popover open={addColumnOpen} onOpenChange={setAddColumnOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" className="w-full h-full flex items-center px-3 gap-1.5 text-foreground/80 transition-colors rounded-none">
                      <Plus className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="text-[13px] font-medium">{t('sweep.entities.add')}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[240px] p-0" align="start" collisionPadding={16}>
                    <Command>
                      <CommandInput placeholder={t('sweep.entities.searchAttributesPlaceholder')} />
                      <CommandList className="[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent" style={{ maxHeight: '400px' }}>
                        <CommandEmpty>{t('sweep.entities.noAttributesFound')}</CommandEmpty>
                        {hiddenBuiltInColumns.length > 0 && (
                          <CommandGroup heading={t('sweep.entities.attributesHeading')}>
                            {hiddenBuiltInColumns.map((col) => (
                              <CommandItem
                                key={col.id}
                                onSelect={() => {
                                  showColumn(col.id);
                                  setAddColumnOpen(false);
                                }}
                              >
                                {col.iconUrl ? (
                                  <img src={col.iconUrl} alt="" className="mr-0.5 h-4 w-4 object-contain" />
                                ) : (
                                  col.icon &&
                                  React.createElement(col.icon, {
                                    className: 'mr-0.5 h-4 w-4',
                                  })
                                )}
                                {col.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {hiddenCustomColumns.length > 0 && (
                          <CommandGroup heading={t('sweep.entities.customAttributesHeading')}>
                            {hiddenCustomColumns.map((col) => (
                              <CommandItem
                                key={col.id}
                                onSelect={() => {
                                  showColumn(col.id);
                                  setAddColumnOpen(false);
                                }}
                              >
                                {col.iconUrl ? (
                                  <img src={col.iconUrl} alt="" className="mr-0.5 h-4 w-4 object-contain" />
                                ) : (
                                  col.icon &&
                                  React.createElement(col.icon, {
                                    className: 'mr-0.5 h-4 w-4',
                                  })
                                )}
                                {col.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {(hiddenEnrichColumns.length > 0 || availableEnrichFields.length > 0) && (
                          <CommandGroup heading={t('sweep.entities.enrichmentHeading')}>
                            {hiddenEnrichColumns.map((col) => (
                              <CommandItem
                                key={col.id}
                                onSelect={() => {
                                  showColumn(col.id);
                                  setAddColumnOpen(false);
                                }}
                              >
                                {col.iconUrl ? (
                                  <img src={col.iconUrl} alt="" className="mr-0.5 h-4 w-4 object-contain" />
                                ) : (
                                  col.icon &&
                                  React.createElement(col.icon, {
                                    className: 'mr-0.5 h-4 w-4',
                                  })
                                )}
                                <span className="flex-1">{col.name}</span>
                                {col.creditCost != null && (
                                  <span className="flex items-center gap-0.5 text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border rounded-[5px] ml-1 px-1 py-0.5">
                                    {col.creditCost}
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-[12px] flex-shrink-0 -translate-y-[0.5px]">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
                                    </svg>
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                            {availableEnrichFields.map((ef) => (
                              <CommandItem
                                key={`${ef.provider}_${ef.operation}`}
                                onSelect={() => {
                                  config.onEnableEnrichField?.(ef.provider, ef.operation);
                                  setAddColumnOpen(false);
                                }}
                              >
                                <img src={ef.logoUrl} alt="" className="mr-0.5 h-4 w-4 object-contain" />
                                <span className="flex-1">{ef.name}</span>
                                <span className="flex items-center gap-0.5 text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border rounded-[5px] ml-1 px-1 py-0.5">
                                  {ef.creditCost}
                                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-[12px] flex-shrink-0 -translate-y-[0.5px]">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
                                  </svg>
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {config.onCreateAttribute && (
                          <>
                            <div className="h-px bg-gray-200 dark:bg-accent mx-1" />
                            <CommandGroup>
                              <CommandItem
                                onSelect={() => {
                                  config.onCreateAttribute!();
                                  setAddColumnOpen(false);
                                }}
                              >
                                <Plus className="mr-0.5 h-4 w-4" />
                                {t('sweep.entities.createNewAttribute')}
                              </CommandItem>
                            </CommandGroup>
                          </>
                        )}
                      </CommandList>
                    </Command>
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
              className={cn(
                "bg-background transition-colors",
                showAddButton && "cursor-pointer",
                showAddButton && addColumnHighlighted && "bg-muted/50",
              )}
              style={{ height: '40px', padding: 0, boxShadow: headerShadow }}
              onMouseEnter={() => showAddButton && setAddColumnHover(true)}
              onMouseLeave={() => setAddColumnHover(false)}
              onClick={() => showAddButton && setAddColumnOpen(true)}
            />
          </>
        )}
      </tr>
    </thead>
  );
}
