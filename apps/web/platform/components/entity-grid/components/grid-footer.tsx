
import React, { useState } from 'react';
import { Plus, Check, Trash2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
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
  CommandSeparator,
} from '@weldsuite/ui/components/command';
import { cn } from '@/lib/utils';
import { useGridContext } from '../context';
import { getCalculationOptions } from '../utils/calculations';

export function GridFooter() {
  const t = useTranslations();
  const {
    config,
    state,
    getVisibleColumns,
    calculateTableWidth,
    setFieldCalculations,
    getCalculationResult,
  } = useGridContext();

  const { columnWidths, fieldCalculations } = state;
  const visibleColumns = getVisibleColumns();
  const [openCalculationField, setOpenCalculationField] = useState<string | null>(null);

  const applyCalculation = (fieldId: string, calculationType: string) => {
    setFieldCalculations({
      ...fieldCalculations,
      [fieldId]: calculationType as any,
    });
  };

  const clearCalculation = (fieldId: string) => {
    const newCalcs = { ...fieldCalculations };
    delete newCalcs[fieldId];
    setFieldCalculations(newCalcs);
  };

  if (config.enableCalculations === false) {
    return null;
  }

  return (
    <div
      className="bg-background sticky bottom-0 z-20 -mt-px"
      style={{ height: '40px' }}
    >
      <table
        className="border-collapse"
        style={{ tableLayout: 'fixed', width: '100%', minWidth: `${calculateTableWidth() + (config.showRowNumbers ? 46 : 0)}px` }}
      >
        <tbody>
          <tr style={{ height: '40px' }}>
            {config.showRowNumbers && (
              <td className="border-r border-t border-border bg-background" style={{ width: 46, height: 40, padding: 0 }} />
            )}
            {visibleColumns.map((column, index) => {
                const isFirstColumn = index === 0;
                const selectedCalculation = fieldCalculations[column.id];
                const calculationResult = selectedCalculation
                  ? getCalculationResult(
                      column.id,
                      column.type,
                      selectedCalculation
                    )
                  : null;
                const options = getCalculationOptions(column.type);

                return (
                  <td
                    key={column.id}
                    className="border-r border-t border-border bg-background"
                    style={{
                      width: columnWidths[column.id] || column.width,
                      height: '40px',
                      fontSize: '13px',
                      color: '#6b7280',
                      fontWeight: '500',
                      padding: 0,
                    }}
                  >
                    <Popover
                      open={openCalculationField === column.id}
                      onOpenChange={(open) => setOpenCalculationField(open ? column.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          className={cn(
                            "w-full h-full pr-3 flex items-center gap-1 transition-colors",
                            isFirstColumn ? "pl-5" : "pl-3",
                            openCalculationField === column.id
                              ? "bg-muted/50 text-foreground/80"
                              : "text-muted-foreground hover:text-foreground/80 hover:bg-muted/50"
                          )}
                          style={{ fontSize: '13px', height: '40px' }}
                        >
                          {calculationResult ? (
                            <span className="text-foreground/80">
                              {calculationResult}
                            </span>
                          ) : (
                            <>
                              <Plus className="h-3 w-3" />
                              {t('sweep.entities.calculate')}
                            </>
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[220px] p-0" align="start">
                        <Command>
                          <CommandList>
                            <CommandGroup heading={t('sweep.entities.calculate')} className="px-1 py-1">
                              {options.map((option) => (
                                <CommandItem
                                  key={option.value}
                                  onSelect={() =>
                                    applyCalculation(column.id, option.value)
                                  }
                                >
                                  {React.createElement(option.icon)}
                                  <span>{option.label}</span>
                                  {selectedCalculation === option.value && (
                                    <Check className="ml-auto text-primary" />
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                            {selectedCalculation && (
                              <>
                                <CommandSeparator />
                                <CommandGroup className="px-1 py-1">
                                  <CommandItem
                                    onSelect={() => clearCalculation(column.id)}
                                    className="text-red-600 data-[selected=true]:text-red-600 data-[selected=true]:bg-red-50 dark:data-[selected=true]:bg-red-950"
                                  >
                                    <Trash2 className="text-red-600" />
                                    <span>{t('sweep.entities.clear')}</span>
                                  </CommandItem>
                                </CommandGroup>
                              </>
                            )}
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </td>
                );
              })}
              {config.allowCustomColumns !== false && (
                <td className="bg-background border-t border-border" style={{ width: '140px', height: '40px', padding: 0 }} />
              )}
              <td className="bg-background border-t border-border" style={{ height: '40px', padding: 0 }} />
            </tr>
          </tbody>
        </table>
    </div>
  );
}
