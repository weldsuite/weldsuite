
import { useState, useRef, useEffect } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Plus, X, Check, Search } from 'lucide-react';
import type { ActiveFilter, FilterConfig } from './types';

interface FilterPillsProps {
  filters: ActiveFilter[];
  filterConfigs: FilterConfig[];
  maxFilters?: number;
  onFiltersChange: (filters: ActiveFilter[]) => void;
}

function getOperatorsForType(filterType?: FilterConfig['filterType']) {
  switch (filterType) {
    case 'text':
      return [
        { value: 'contains', label: 'contains' },
        { value: 'not contains', label: 'not contains' },
        { value: 'is', label: 'is' },
        { value: 'is not', label: 'is not' },
      ];
    case 'number':
      return [
        { value: 'equals', label: 'equals' },
        { value: 'gt', label: 'greater than' },
        { value: 'lt', label: 'less than' },
      ];
    case 'date':
      return [
        { value: 'is', label: 'is' },
        { value: 'before', label: 'before' },
        { value: 'after', label: 'after' },
      ];
    case 'boolean':
      return [{ value: 'is', label: 'is' }];
    default:
      return [
        { value: 'is', label: 'is' },
        { value: 'is not', label: 'is not' },
      ];
  }
}

/**
 * Filter pills row. The interaction model is:
 *
 *   1. Click "Filter" → field-picker popover opens at the Filter button.
 *   2. Click a field   → pill is added IMMEDIATELY (with placeholder
 *                        operator + value) and the pill's own operator
 *                        popover auto-opens directly under "Select
 *                        condition" on the new pill.
 *   3. Click operator  → operator popover closes, the pill's value
 *                        popover auto-opens under "Select value".
 *   4. Click value     → value popover closes, the pill is complete.
 *
 *   Boolean fields skip step 3's operator picker (operator pre-set to
 *   "is") and jump straight from step 1 to step 4's value picker.
 *
 * Two subtle pitfalls — both fixed here:
 *
 *   A) Wizard close-animation wiggle. After the field click, the wizard
 *      trigger ("Filter" button) is replaced in the layout by a small
 *      "+" button placed AFTER the new pill. While Radix played its
 *      exit animation on the wizard popover, the popover briefly
 *      followed the moving trigger to the right edge of the row before
 *      the operator popover opened on the pill. Killed via
 *      `data-[state=closed]:!animate-none data-[state=closed]:!duration-0`
 *      on the wizard PopoverContent — it unmounts in one frame.
 *
 *   B) Auto-opened operator popover dismissed-on-open. The same click
 *      that picks the field continues bubbling after the operator
 *      popover opens. Radix's dismissable layer subscribes when the
 *      popover opens, sees the still-bubbling click, decides it's
 *      outside, and closes the popover. We sidestep this by deferring
 *      the open into a `setTimeout(0)` scheduled directly from the
 *      click handler — by the time it fires, the click event has fully
 *      finished bubbling. We also `preventDefault` on the wizard
 *      popover's `onCloseAutoFocus` so closing the wizard doesn't yank
 *      focus back to the trigger and steal it from the operator popover.
 */
export function FilterPills({
  filters,
  filterConfigs,
  maxFilters = 5,
  onFiltersChange,
}: FilterPillsProps) {
  const filterIdCounterRef = useRef(0);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [editingFilterIndex, setEditingFilterIndex] = useState<number | null>(null);
  const [editingOperatorIndex, setEditingOperatorIndex] = useState<number | null>(null);
  const [textInputValue, setTextInputValue] = useState('');
  const [valueSearchQuery, setValueSearchQuery] = useState('');

  // Reset transient menu inputs whenever the field-picker menu closes.
  useEffect(() => {
    if (filterMenuOpen) return;
    setTextInputValue('');
    setValueSearchQuery('');
  }, [filterMenuOpen]);

  const getFilterConfig = (field: string) =>
    filterConfigs.find((c) => c.field === field);

  const getFilterDisplayValue = (filter: ActiveFilter) => {
    const config = getFilterConfig(filter.field);
    if (config?.getDisplayValue) return config.getDisplayValue(filter.value);
    if (config?.filterType === 'boolean') return filter.value === 'true' ? 'Yes' : 'No';
    if (config?.filterType === 'date') {
      try {
        return new Date(filter.value).toLocaleDateString();
      } catch {
        return filter.value;
      }
    }
    const option = config?.options.find((o) => o.value === filter.value);
    return option?.label || filter.value;
  };

  const getOperatorLabel = (filter: ActiveFilter) => {
    const config = getFilterConfig(filter.field);
    const operators = getOperatorsForType(config?.filterType);
    return (
      operators.find((o) => o.value === filter.operator)?.label || filter.operator
    );
  };

  const getPlaceholder = (field: string) => {
    const config = getFilterConfig(field);
    if (config?.filterType === 'text') return `Type ${config.label.toLowerCase()}`;
    if (config?.filterType === 'number') return 'Enter value';
    return `Select ${config?.label.toLowerCase() || 'value'}`;
  };

  // Step 1 → Step 2: user picked a field in the wizard popover.
  // Add the pill, close the wizard, schedule the auto-open of the
  // pill's operator (or value, for booleans) popover on the NEXT
  // macrotask so the click event has finished bubbling.
  const handlePickField = (field: string) => {
    if (filters.length >= maxFilters) return;
    const config = getFilterConfig(field);
    const newId = `filter-${++filterIdCounterRef.current}`;
    const isBool = config?.filterType === 'boolean';
    const newIndex = filters.length;

    onFiltersChange([
      ...filters,
      { id: newId, field, operator: isBool ? 'is' : '', value: '' },
    ]);
    setFilterMenuOpen(false);

    setTimeout(() => {
      if (isBool) setEditingFilterIndex(newIndex);
      else setEditingOperatorIndex(newIndex);
    }, 0);
  };

  const updateFilterOperator = (index: number, newOperator: string) => {
    const next = [...filters];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, operator: newOperator };
    onFiltersChange(next);
    setEditingOperatorIndex(null);

    // Step 2 → Step 3: if there's no value yet, auto-open the value
    // popover on the same pill. Same setTimeout(0) trick as Step 1→2
    // so the click that picked the operator finishes bubbling first.
    if (!next[index].value) {
      const config = getFilterConfig(next[index].field);
      if (config?.filterType === 'text' || config?.filterType === 'number') {
        setTextInputValue('');
      }
      setTimeout(() => {
        setEditingFilterIndex(index);
      }, 0);
    }
  };

  const updateFilterValue = (index: number, newValue: string) => {
    const next = [...filters];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, value: newValue };
    onFiltersChange(next);
    setEditingFilterIndex(null);
    setTextInputValue('');
  };

  const removeFilter = (index: number) => {
    setEditingOperatorIndex(null);
    setEditingFilterIndex(null);
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  // Generic value picker — used by each pill's value popover.
  const renderValuePicker = (
    config: FilterConfig | undefined,
    currentValue: string,
    onSelect: (value: string) => void,
    placeholderText: string,
  ) => {
    const filterType = config?.filterType || 'select';

    switch (filterType) {
      case 'text':
        return (
          <div className="p-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (textInputValue.trim()) onSelect(textInputValue.trim());
              }}
            >
              <Input
                autoFocus
                value={textInputValue}
                onChange={(e) => setTextInputValue(e.target.value)}
                placeholder={placeholderText}
                className="h-8 text-sm"
              />
              <Button type="submit" size="sm" className="w-full mt-2 h-7 text-xs">
                Apply
              </Button>
            </form>
          </div>
        );

      case 'number':
        return (
          <div className="p-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (textInputValue.trim()) onSelect(textInputValue.trim());
              }}
            >
              <Input
                autoFocus
                type="number"
                value={textInputValue}
                onChange={(e) => setTextInputValue(e.target.value)}
                placeholder="Enter value"
                className="h-8 text-sm"
              />
              <Button type="submit" size="sm" className="w-full mt-2 h-7 text-xs">
                Apply
              </Button>
            </form>
          </div>
        );

      case 'date':
        return (
          <div className="p-2">
            <Input
              autoFocus
              type="date"
              value={currentValue || ''}
              onChange={(e) => {
                if (e.target.value) onSelect(e.target.value);
              }}
              className="h-8 text-sm"
            />
          </div>
        );

      case 'boolean':
        return (
          <>
            <button
              onClick={() => onSelect('true')}
              className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
            >
              <span>Yes</span>
              {currentValue === 'true' && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
            <button
              onClick={() => onSelect('false')}
              className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
            >
              <span>No</span>
              {currentValue === 'false' && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          </>
        );

      default: {
        if (!config?.options || config.options.length === 0) {
          return (
            <div className="px-2 py-3 text-sm text-muted-foreground text-center">
              No options available
            </div>
          );
        }
        const filtered = config.searchable
          ? config.options.filter((o) =>
              o.label.toLowerCase().includes(valueSearchQuery.toLowerCase()),
            )
          : config.options;

        return (
          <>
            {config.searchable && (
              <div className="flex items-center gap-1.5 px-3 h-[36px] border-b border-border">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0 -translate-y-[0.5px]" />
                <input
                  autoFocus
                  value={valueSearchQuery}
                  onChange={(e) => setValueSearchQuery(e.target.value)}
                  placeholder="Search..."
                  className="flex-1 text-[13px] bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </div>
            )}
            <div className={config.searchable ? 'max-h-[200px] overflow-y-auto p-1' : ''}>
              {filtered.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                  No results
                </div>
              ) : (
                filtered.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      onSelect(option.value);
                      setValueSearchQuery('');
                    }}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
                  >
                    <span>{option.label}</span>
                    {currentValue === option.value && (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        );
      }
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Active filter pills */}
      {filters.map((filter, index) => {
        const config = getFilterConfig(filter.field);
        const operators = getOperatorsForType(config?.filterType);

        return (
          <div
            key={filter.id}
            className="flex items-center h-[32px] bg-muted/50 rounded-md border border-border text-sm"
          >
            {/* Field name */}
            <div className="flex items-center px-2 h-full">
              <span className="text-muted-foreground capitalize">
                {config?.label || filter.field}
              </span>
            </div>

            <div className="h-full w-px bg-border" />

            {/* Operator popover */}
            <Popover
              open={editingOperatorIndex === index}
              onOpenChange={(open) =>
                setEditingOperatorIndex(open ? index : null)
              }
            >
              <PopoverTrigger asChild>
                <button
                  className={`px-2 h-full hover:bg-muted transition-colors ${
                    filter.operator
                      ? 'text-foreground'
                      : 'text-muted-foreground/60'
                  }`}
                >
                  {filter.operator
                    ? getOperatorLabel(filter)
                    : 'Select condition'}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto min-w-28 p-1">
                {operators.map((op) => (
                  <button
                    key={op.value}
                    onClick={() => updateFilterOperator(index, op.value)}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
                  >
                    <span>{op.label}</span>
                    {filter.operator === op.value && (
                      <Check className="h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            <div className="h-full w-px bg-border" />

            {/* Value popover */}
            <Popover
              open={editingFilterIndex === index}
              onOpenChange={(open) => {
                setEditingFilterIndex(open ? index : null);
                if (
                  open &&
                  (config?.filterType === 'text' || config?.filterType === 'number')
                ) {
                  setTextInputValue(filter.value || '');
                }
                if (!open) setValueSearchQuery('');
              }}
            >
              <PopoverTrigger asChild>
                <button className="flex items-center px-2 h-full hover:bg-muted transition-colors">
                  {filter.value ? (
                    <span className="text-foreground">
                      {getFilterDisplayValue(filter)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">
                      {getPlaceholder(filter.field)}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className={cn('w-auto min-w-40', config?.searchable ? 'p-0' : 'p-1')}
              >
                {renderValuePicker(
                  config,
                  filter.value,
                  (value) => updateFilterValue(index, value),
                  getPlaceholder(filter.field),
                )}
              </PopoverContent>
            </Popover>

            <div className="h-full w-px bg-border" />

            {/* Remove button */}
            <button
              onClick={() => removeFilter(index)}
              className="px-[7px] text-muted-foreground hover:text-foreground hover:bg-muted h-full rounded-r-md transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {/* Wizard: field picker (Filter / + button) */}
      <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
        <PopoverTrigger asChild>
          {filters.length > 0 && filters.length < maxFilters ? (
            <button className="flex items-center justify-center h-[32px] w-[30px] border border-dashed border-border rounded-md text-muted-foreground hover:text-foreground hover:border-border">
              <Plus className="h-3.5 w-3.5" />
            </button>
          ) : filters.length === 0 ? (
            <Button
              variant="outline"
              className="h-8 text-sm px-3 shadow-none text-muted-foreground"
            >
              Filter
            </Button>
          ) : null}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          // No close animation: the wizard trigger ("Filter"/"+") moves
          // when a pill is added; without this override the closing popover
          // visibly follows the trigger to the right before the operator
          // popover opens on the new pill.
          className="w-auto min-w-40 p-1 data-[state=closed]:!animate-none data-[state=closed]:!duration-0"
          // Don't restore focus to the wizard trigger on close — the
          // operator popover that opens next would lose focus and dismiss
          // itself.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {filterConfigs.map((config) => (
            <button
              key={config.field}
              onClick={() => handlePickField(config.field)}
              className="w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
            >
              {config.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
