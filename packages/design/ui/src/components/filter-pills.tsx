import * as React from 'react';
import { Plus, X, Check, Search } from 'lucide-react';

import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterConfig {
  field: string;
  label: string;
  options: FilterOption[];
  filterType?: 'select' | 'text' | 'number' | 'date' | 'boolean';
  searchable?: boolean;
  getDisplayValue?: (value: string) => string;
}

export interface ActiveFilter {
  id: string;
  field: string;
  operator: string;
  value: string;
}

export interface FilterPillsProps {
  filters: ActiveFilter[];
  filterConfigs: FilterConfig[];
  maxFilters?: number;
  onFiltersChange: (filters: ActiveFilter[]) => void;
}

// ---------------------------------------------------------------------------

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
 * Declarative filter pills: renders a chip per active filter (with field →
 * operator → value popovers) and an "Add filter" button/menu.
 *
 * Controlled component — the caller owns `filters` state and reacts to
 * `onFiltersChange`. Typically paired with `ListToolbar`, which embeds this
 * component in its left slot.
 */
export function FilterPills({
  filters,
  filterConfigs,
  maxFilters = 5,
  onFiltersChange,
}: FilterPillsProps) {
  const filterIdCounter = React.useRef(0);
  const [filterMenuOpen, setFilterMenuOpen] = React.useState(false);
  const [editingFilterIndex, setEditingFilterIndex] = React.useState<number | null>(null);
  const [editingOperatorIndex, setEditingOperatorIndex] = React.useState<number | null>(null);
  const [textInputValue, setTextInputValue] = React.useState('');
  const [valueSearchQuery, setValueSearchQuery] = React.useState('');

  const addFilter = (field: string) => {
    if (filters.length >= maxFilters) return;
    const newIndex = filters.length;
    const newId = `filter-${++filterIdCounter.current}`;
    const config = filterConfigs.find((c) => c.field === field);
    const defaultOperator = config?.filterType === 'boolean' ? 'is' : '';

    setEditingOperatorIndex(null);
    setEditingFilterIndex(null);
    setTextInputValue('');
    setFilterMenuOpen(false);

    setTimeout(() => {
      onFiltersChange([
        ...filters,
        { id: newId, field, operator: defaultOperator, value: '' },
      ]);
      requestAnimationFrame(() => {
        if (config?.filterType === 'boolean') {
          setEditingFilterIndex(newIndex);
        } else {
          setEditingOperatorIndex(newIndex);
        }
      });
    }, 30);
  };

  const removeFilter = (index: number) => {
    setEditingOperatorIndex(null);
    setEditingFilterIndex(null);
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const updateFilterOperator = (index: number, newOperator: string) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], operator: newOperator };

    setEditingOperatorIndex(null);
    onFiltersChange(newFilters);

    if (!newFilters[index].value) {
      const config = getFilterConfig(newFilters[index].field);
      if (config?.filterType === 'text' || config?.filterType === 'number') {
        setTextInputValue('');
      }
      requestAnimationFrame(() => {
        setEditingFilterIndex(index);
      });
    }
  };

  const updateFilterValue = (index: number, newValue: string) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], value: newValue };
    onFiltersChange(newFilters);
    setEditingFilterIndex(null);
    setTextInputValue('');
  };

  const getFilterConfig = (field: string) => filterConfigs.find((c) => c.field === field);

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
    return operators.find((o) => o.value === filter.operator)?.label || filter.operator;
  };

  const getPlaceholder = (field: string) => {
    const config = getFilterConfig(field);
    if (config?.filterType === 'text') return `Type ${config.label.toLowerCase()}`;
    if (config?.filterType === 'number') return 'Enter value';
    return `Select ${config?.label.toLowerCase() || 'value'}`;
  };

  const renderValuePopoverContent = (
    filter: ActiveFilter,
    index: number,
    config: FilterConfig | undefined,
  ) => {
    const filterType = config?.filterType || 'select';

    switch (filterType) {
      case 'text':
        return (
          <div className="p-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (textInputValue.trim()) updateFilterValue(index, textInputValue.trim());
              }}
            >
              <Input
                autoFocus
                value={textInputValue}
                onChange={(e) => setTextInputValue(e.target.value)}
                placeholder={getPlaceholder(filter.field)}
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
                if (textInputValue.trim()) updateFilterValue(index, textInputValue.trim());
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
              value={filter.value || ''}
              onChange={(e) => {
                if (e.target.value) updateFilterValue(index, e.target.value);
              }}
              className="h-8 text-sm"
            />
          </div>
        );

      case 'boolean':
        return (
          <>
            <button
              onClick={() => updateFilterValue(index, 'true')}
              className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
            >
              <span>Yes</span>
              {filter.value === 'true' && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
            <button
              onClick={() => updateFilterValue(index, 'false')}
              className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
            >
              <span>No</span>
              {filter.value === 'false' && <Check className="h-3.5 w-3.5 text-primary" />}
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
                      updateFilterValue(index, option.value);
                      setValueSearchQuery('');
                    }}
                    className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
                  >
                    <span>{option.label}</span>
                    {filter.value === option.value && (
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
      {filters.map((filter, index) => {
        const config = getFilterConfig(filter.field);
        const operators = getOperatorsForType(config?.filterType);

        return (
          <div
            key={filter.id}
            className="flex items-center h-[32px] bg-muted/50 rounded-md border border-border text-sm"
          >
            <div className="flex items-center px-2 h-full">
              <span className="text-muted-foreground capitalize">
                {config?.label || filter.field}
              </span>
            </div>

            <div className="h-full w-px bg-border" />

            <Popover
              open={editingOperatorIndex === index}
              onOpenChange={(open) => setEditingOperatorIndex(open ? index : null)}
            >
              <PopoverTrigger asChild>
                <button
                  className={`px-2 h-full hover:bg-muted transition-colors ${
                    filter.operator ? 'text-foreground' : 'text-muted-foreground/60'
                  }`}
                >
                  {filter.operator ? getOperatorLabel(filter) : 'Select condition'}
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
                    <span className="text-foreground">{getFilterDisplayValue(filter)}</span>
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
                {renderValuePopoverContent(filter, index, config)}
              </PopoverContent>
            </Popover>

            <div className="h-full w-px bg-border" />

            <button
              onClick={() => removeFilter(index)}
              className="px-[7px] text-muted-foreground hover:text-foreground hover:bg-muted h-full rounded-r-md transition-colors"
              aria-label="Remove filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
        <PopoverTrigger asChild>
          {filters.length > 0 && filters.length < maxFilters ? (
            <button
              className="flex items-center justify-center h-[32px] w-[30px] border border-dashed border-border rounded-md text-muted-foreground hover:text-foreground hover:border-border"
              aria-label="Add filter"
            >
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
        <PopoverContent align="start" className="w-40 p-1">
          {filterConfigs.map((config) => (
            <button
              key={config.field}
              onClick={() => addFilter(config.field)}
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
