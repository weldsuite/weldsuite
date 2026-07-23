"use client"

import * as React from 'react';
import { useState, useMemo } from 'react';
import { Button } from '../../button';
import { Input } from '../../input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../select';
import { Plus, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { VariableInput } from './variable-input';
import { getEntityFields, type FieldDefinition } from './field-builder';

const OPERATOR_SYMBOLS: Record<string, string> = {
  eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
  contains: '~', startsWith: '^', endsWith: '$', in: '[]', isNull: '?', isNotNull: '!',
};

export interface FilterCondition {
  id: string;
  field: string;
  operator: string;
  value: string;
}

interface FilterBuilderProps {
  filters: FilterCondition[];
  onChange: (filters: FilterCondition[]) => void;
  entityType?: string;
  triggerType?: string;
  steps?: Array<{ id: string; name: string; type: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
  className?: string;
  labels?: {
    addFilter?: string;
    noFilters?: string;
    fieldPlaceholder?: string;
    valuePlaceholder?: string;
    operators?: Record<string, string>;
  };
}

export function FilterBuilder({
  filters,
  onChange,
  entityType,
  triggerType,
  steps = [],
  workflowVariables = [],
  className,
  labels = {},
}: FilterBuilderProps) {
  const OPERATORS = useMemo(() => {
    const opLabels = labels.operators || {};
    return Object.keys(OPERATOR_SYMBOLS).map((value) => ({
      value,
      label: opLabels[value] ?? value,
      symbol: OPERATOR_SYMBOLS[value],
    }));
  }, [labels.operators]);

  const suggestedFields = entityType ? getEntityFields(entityType) : [];

  const addFilter = () => {
    const newFilter: FilterCondition = {
      id: `filter_${Date.now()}`,
      field: '',
      operator: 'eq',
      value: '',
    };
    onChange([...filters, newFilter]);
  };

  const removeFilter = (id: string) => {
    onChange(filters.filter((f) => f.id !== id));
  };

  const updateFilter = (id: string, updates: Partial<FilterCondition>) => {
    onChange(filters.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  };

  const operatorNeedsValue = (op: string) => !['isNull', 'isNotNull'].includes(op);

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-2">
        {filters.map((filter, index) => {
          const fieldDef = suggestedFields.find((f) => f.name === filter.field);

          return (
            <div key={filter.id} className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg">
              {index > 0 && (
                <span className="text-xs text-muted-foreground font-medium w-8">AND</span>
              )}
              {index === 0 && <span className="w-8" />}

              <div className="w-32 shrink-0">
                {suggestedFields.length > 0 ? (
                  <Select value={filter.field} onValueChange={(v) => updateFilter(filter.id, { field: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={labels.fieldPlaceholder || 'Field'}>
                        {fieldDef ? fieldDef.label : filter.field || (labels.fieldPlaceholder || 'Field')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {suggestedFields.map((field) => (
                        <SelectItem key={field.name} value={field.name}>{field.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={filter.field}
                    onChange={(e) => updateFilter(filter.id, { field: e.target.value })}
                    placeholder={labels.fieldPlaceholder || 'Field'}
                    className="h-8 text-xs"
                  />
                )}
              </div>

              <div className="w-32 shrink-0">
                <Select value={filter.operator} onValueChange={(v) => updateFilter(filter.id, { operator: v })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERATORS.map((op) => (
                      <SelectItem key={op.value} value={op.value}>
                        <span className="flex items-center gap-2">
                          <code className="text-xs bg-muted px-1 rounded">{op.symbol}</code>
                          {op.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {operatorNeedsValue(filter.operator) && (
                <div className="flex-1">
                  <VariableInput
                    value={filter.value}
                    onChange={(v) => updateFilter(filter.id, { value: v })}
                    placeholder={labels.valuePlaceholder || 'Value...'}
                    triggerType={triggerType}
                    steps={steps}
                    workflowVariables={workflowVariables}
                    className="h-8 text-xs"
                  />
                </div>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeFilter(filter.id)}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={addFilter} className="gap-1">
        <Plus className="h-3.5 w-3.5" />
        {labels.addFilter || 'Add Filter'}
      </Button>

      {filters.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-2">
          {labels.noFilters || 'No filters yet'}
        </p>
      )}
    </div>
  );
}
