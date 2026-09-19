import { useEffect, useRef, useState } from 'react';
import { Plus, X, Check, Search } from 'lucide-react';
import { cn } from '../cn';
import { Button } from '../button';
import { Input } from '../input';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import type { ActiveFilter, FilterConfig } from './types';

export interface FilterPillsBarProps {
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

export function FilterPills({
  filters,
  filterConfigs,
  maxFilters = 5,
  onFiltersChange,
}: FilterPillsBarProps) {
  const filterIdCounterRef = useRef(0);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [editingFilterIndex, setEditingFilterIndex] = useState<number | null>(null);
  const [editingOperatorIndex, setEditingOperatorIndex] = useState<number | null>(null);
  const [textInputValue, setTextInputValue] = useState('');
  const [valueSearchQuery, setValueSearchQuery] = useState('');

  useEffect(() => {
    if (filterMenuOpen) return;
    setTextInputValue('');
    setValueSearchQuery('');
  }, [filterMenuOpen]);

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
          <div className="wui-elist-filter-value-form">
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
                className="wui-elist-filter-input"
              />
              <Button type="submit" size="sm" className="wui-elist-filter-apply">
                Apply
              </Button>
            </form>
          </div>
        );

      case 'number':
        return (
          <div className="wui-elist-filter-value-form">
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
                className="wui-elist-filter-input"
              />
              <Button type="submit" size="sm" className="wui-elist-filter-apply">
                Apply
              </Button>
            </form>
          </div>
        );

      case 'date':
        return (
          <div className="wui-elist-filter-value-form">
            <Input
              autoFocus
              type="date"
              value={currentValue || ''}
              onChange={(e) => {
                if (e.target.value) onSelect(e.target.value);
              }}
              className="wui-elist-filter-input"
            />
          </div>
        );

      case 'boolean':
        return (
          <>
            <button
              type="button"
              className="wui-elist-filter-option"
              onClick={() => onSelect('true')}
            >
              <span>Yes</span>
              {currentValue === 'true' && <Check className="wui-elist-icon wui-elist-icon--sm" />}
            </button>
            <button
              type="button"
              className="wui-elist-filter-option"
              onClick={() => onSelect('false')}
            >
              <span>No</span>
              {currentValue === 'false' && <Check className="wui-elist-icon wui-elist-icon--sm" />}
            </button>
          </>
        );

      default: {
        if (!config?.options || config.options.length === 0) {
          return (
            <div className="wui-elist-filter-empty">No options available</div>
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
              <div className="wui-elist-filter-search">
                <Search className="wui-elist-icon wui-elist-icon--sm" />
                <input
                  autoFocus
                  value={valueSearchQuery}
                  onChange={(e) => setValueSearchQuery(e.target.value)}
                  placeholder="Search..."
                  className="wui-elist-filter-search-input"
                />
              </div>
            )}
            <div className={cn(config.searchable && 'wui-elist-filter-options-scroll')}>
              {filtered.length === 0 ? (
                <div className="wui-elist-filter-empty">No results</div>
              ) : (
                filtered.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="wui-elist-filter-option"
                    onClick={() => {
                      onSelect(option.value);
                      setValueSearchQuery('');
                    }}
                  >
                    <span>{option.label}</span>
                    {currentValue === option.value && (
                      <Check className="wui-elist-icon wui-elist-icon--sm" />
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

  if (filterConfigs.length === 0) return null;

  return (
    <div className="wui-elist-filters">
      {filters.map((filter, index) => {
        const config = getFilterConfig(filter.field);
        const operators = getOperatorsForType(config?.filterType);

        return (
          <div key={filter.id} className="wui-elist-filter-pill">
            <div className="wui-elist-filter-pill__field">
              <span className="wui-elist-filter-pill__field-label">
                {config?.label || filter.field}
              </span>
            </div>

            <div className="wui-elist-filter-pill__divider" aria-hidden />

            <Popover
              open={editingOperatorIndex === index}
              onOpenChange={(open) => setEditingOperatorIndex(open ? index : null)}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'wui-elist-filter-pill__segment',
                    filter.operator
                      ? 'wui-elist-filter-pill__segment--filled'
                      : 'wui-elist-filter-pill__segment--placeholder',
                  )}
                >
                  {filter.operator ? getOperatorLabel(filter) : 'Select condition'}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="wui-elist-filter-popover">
                {operators.map((op) => (
                  <button
                    key={op.value}
                    type="button"
                    className="wui-elist-filter-option"
                    onClick={() => updateFilterOperator(index, op.value)}
                  >
                    <span>{op.label}</span>
                    {filter.operator === op.value && (
                      <Check className="wui-elist-icon wui-elist-icon--sm" />
                    )}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            <div className="wui-elist-filter-pill__divider" aria-hidden />

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
                <button type="button" className="wui-elist-filter-pill__segment">
                  {filter.value ? (
                    <span className="wui-elist-filter-pill__segment--filled">
                      {getFilterDisplayValue(filter)}
                    </span>
                  ) : (
                    <span className="wui-elist-filter-pill__segment--placeholder">
                      {getPlaceholder(filter.field)}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className={cn(
                  'wui-elist-filter-popover',
                  config?.searchable && 'wui-elist-filter-popover--searchable',
                )}
              >
                {renderValuePicker(
                  config,
                  filter.value,
                  (value) => updateFilterValue(index, value),
                  getPlaceholder(filter.field),
                )}
              </PopoverContent>
            </Popover>

            <div className="wui-elist-filter-pill__divider" aria-hidden />

            <button
              type="button"
              className="wui-elist-filter-pill__remove"
              onClick={() => removeFilter(index)}
              aria-label="Remove filter"
            >
              <X className="wui-elist-icon wui-elist-icon--sm" />
            </button>
          </div>
        );
      })}

      <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
        <PopoverTrigger asChild>
          {filters.length > 0 && filters.length < maxFilters ? (
            <button type="button" className="wui-elist-filter-add-icon" aria-label="Add filter">
              <Plus className="wui-elist-icon wui-elist-icon--sm" />
            </button>
          ) : filters.length === 0 ? (
            <Button variant="outline" className="wui-elist-filter-add-btn">
              Filter
            </Button>
          ) : null}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="wui-elist-filter-popover wui-elist-filter-popover--wizard"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {filterConfigs.map((config) => (
            <button
              key={config.field}
              type="button"
              className="wui-elist-filter-option"
              onClick={() => handlePickField(config.field)}
            >
              {config.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
