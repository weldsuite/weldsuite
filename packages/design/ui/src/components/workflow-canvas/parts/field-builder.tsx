"use client"

import * as React from 'react';
import { useState } from 'react';
import { Button } from '../../button';
import { Input } from '../../input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../select';
import { Plus, X, GripVertical } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { VariableInput } from './variable-input';

export interface FieldDefinition {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'array';
  required?: boolean;
  description?: string;
}

const COMMON_ENTITY_FIELDS: Record<string, FieldDefinition[]> = {
  lead: [
    { name: 'name', label: 'Name', type: 'string', required: true },
    { name: 'email', label: 'Email', type: 'string' },
    { name: 'phone', label: 'Phone', type: 'string' },
    { name: 'company', label: 'Company', type: 'string' },
    { name: 'source', label: 'Lead Source', type: 'string' },
    { name: 'status', label: 'Status', type: 'string' },
    { name: 'notes', label: 'Notes', type: 'string' },
  ],
  customer: [
    { name: 'name', label: 'Name', type: 'string', required: true },
    { name: 'email', label: 'Email', type: 'string' },
    { name: 'phone', label: 'Phone', type: 'string' },
    { name: 'company', label: 'Company', type: 'string' },
    { name: 'address', label: 'Address', type: 'string' },
    { name: 'city', label: 'City', type: 'string' },
    { name: 'country', label: 'Country', type: 'string' },
    { name: 'notes', label: 'Notes', type: 'string' },
  ],
  contact: [
    { name: 'firstName', label: 'First Name', type: 'string', required: true },
    { name: 'lastName', label: 'Last Name', type: 'string' },
    { name: 'email', label: 'Email', type: 'string' },
    { name: 'phone', label: 'Phone', type: 'string' },
    { name: 'title', label: 'Job Title', type: 'string' },
    { name: 'department', label: 'Department', type: 'string' },
  ],
  opportunity: [
    { name: 'name', label: 'Name', type: 'string', required: true },
    { name: 'value', label: 'Value', type: 'number' },
    { name: 'probability', label: 'Probability (%)', type: 'number' },
    { name: 'expectedCloseDate', label: 'Expected Close Date', type: 'date' },
    { name: 'stageId', label: 'Stage', type: 'string' },
    { name: 'notes', label: 'Notes', type: 'string' },
  ],
  ticket: [
    { name: 'subject', label: 'Subject', type: 'string', required: true },
    { name: 'description', label: 'Description', type: 'string' },
    { name: 'priority', label: 'Priority', type: 'string' },
    { name: 'status', label: 'Status', type: 'string' },
    { name: 'departmentId', label: 'Department', type: 'string' },
    { name: 'assigneeId', label: 'Assignee', type: 'string' },
  ],
  order: [
    { name: 'customerId', label: 'Customer', type: 'string', required: true },
    { name: 'status', label: 'Status', type: 'string' },
    { name: 'total', label: 'Total', type: 'number' },
    { name: 'currency', label: 'Currency', type: 'string' },
    { name: 'notes', label: 'Notes', type: 'string' },
  ],
  product: [
    { name: 'name', label: 'Name', type: 'string', required: true },
    { name: 'sku', label: 'SKU', type: 'string' },
    { name: 'price', label: 'Price', type: 'number' },
    { name: 'description', label: 'Description', type: 'string' },
    { name: 'stock', label: 'Stock', type: 'number' },
    { name: 'categoryId', label: 'Category', type: 'string' },
  ],
  project: [
    { name: 'name', label: 'Name', type: 'string', required: true },
    { name: 'description', label: 'Description', type: 'string' },
    { name: 'status', label: 'Status', type: 'string' },
    { name: 'startDate', label: 'Start Date', type: 'date' },
    { name: 'endDate', label: 'End Date', type: 'date' },
    { name: 'budget', label: 'Budget', type: 'number' },
  ],
  task: [
    { name: 'title', label: 'Title', type: 'string', required: true },
    { name: 'description', label: 'Description', type: 'string' },
    { name: 'status', label: 'Status', type: 'string' },
    { name: 'priority', label: 'Priority', type: 'string' },
    { name: 'dueDate', label: 'Due Date', type: 'date' },
    { name: 'assigneeId', label: 'Assignee', type: 'string' },
    { name: 'projectId', label: 'Project', type: 'string' },
  ],
};

export function getEntityFields(entityType: string): FieldDefinition[] {
  return COMMON_ENTITY_FIELDS[entityType] || [];
}

interface FieldEntry {
  id: string;
  key: string;
  value: string;
}

interface FieldBuilderProps {
  fields: Record<string, unknown>;
  onChange: (fields: Record<string, unknown>) => void;
  entityType?: string;
  triggerType?: string;
  steps?: Array<{ id: string; name: string; type: string }>;
  workflowVariables?: Array<{ name: string; type?: string }>;
  className?: string;
  labels?: {
    addField?: string;
    fieldPlaceholder?: string;
    fieldNamePlaceholder?: string;
    customField?: string;
  };
}

export function FieldBuilder({
  fields,
  onChange,
  entityType,
  triggerType,
  steps = [],
  workflowVariables = [],
  className,
  labels = {},
}: FieldBuilderProps) {
  const [entries, setEntries] = useState<FieldEntry[]>(() => {
    return Object.entries(fields).map(([key, value], index) => ({
      id: `field_${index}`,
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
    }));
  });

  const suggestedFields = entityType ? getEntityFields(entityType) : [];
  const usedKeys = entries.map((e) => e.key);
  const availableFields = suggestedFields.filter((f) => !usedKeys.includes(f.name));

  const updateParent = (newEntries: FieldEntry[]) => {
    const result: Record<string, unknown> = {};
    for (const entry of newEntries) {
      if (entry.key) {
        try {
          result[entry.key] = JSON.parse(entry.value);
        } catch {
          result[entry.key] = entry.value;
        }
      }
    }
    onChange(result);
  };

  const addField = (fieldName?: string) => {
    const newEntry: FieldEntry = { id: `field_${Date.now()}`, key: fieldName || '', value: '' };
    const newEntries = [...entries, newEntry];
    setEntries(newEntries);
    updateParent(newEntries);
  };

  const removeField = (id: string) => {
    const newEntries = entries.filter((e) => e.id !== id);
    setEntries(newEntries);
    updateParent(newEntries);
  };

  const updateField = (id: string, key: string, value: string) => {
    const newEntries = entries.map((e) => e.id === id ? { ...e, key, value } : e);
    setEntries(newEntries);
    updateParent(newEntries);
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-2">
        {entries.map((entry) => {
          const fieldDef = suggestedFields.find((f) => f.name === entry.key);

          return (
            <div key={entry.id} className="flex items-start gap-2 p-2 bg-muted/30 rounded-lg">
              <GripVertical className="h-4 w-4 text-muted-foreground mt-2.5 cursor-grab shrink-0" />

              <div className="w-40 shrink-0">
                {suggestedFields.length > 0 ? (
                  <Select value={entry.key} onValueChange={(v) => updateField(entry.id, v, entry.value)}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder={labels.fieldPlaceholder || 'Field'}>
                        {fieldDef ? fieldDef.label : entry.key || (labels.fieldPlaceholder || 'Field')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {entry.key && !suggestedFields.find((f) => f.name === entry.key) && (
                        <SelectItem value={entry.key}>
                          <span className="font-mono text-xs">{entry.key}</span>
                        </SelectItem>
                      )}
                      {suggestedFields.map((field) => (
                        <SelectItem key={field.name} value={field.name} disabled={usedKeys.includes(field.name) && entry.key !== field.name}>
                          <div className="flex flex-col">
                            <span>{field.label}</span>
                            <span className="text-xs text-muted-foreground font-mono">{field.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">
                        <span className="text-muted-foreground">{labels.customField || 'Custom field'}</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={entry.key}
                    onChange={(e) => updateField(entry.id, e.target.value, entry.value)}
                    placeholder={labels.fieldNamePlaceholder || 'field_name'}
                    className="h-9"
                  />
                )}
              </div>

              <div className="flex-1">
                <VariableInput
                  value={entry.value}
                  onChange={(v) => updateField(entry.id, entry.key, v)}
                  placeholder={fieldDef?.description || 'Value...'}
                  triggerType={triggerType}
                  steps={steps}
                  workflowVariables={workflowVariables}
                />
              </div>

              <Button type="button" variant="ghost" size="sm" onClick={() => removeField(entry.id)} className="h-9 px-2 text-muted-foreground hover:text-destructive">
                <X className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => addField()} className="gap-1">
          <Plus className="h-3.5 w-3.5" />
          {labels.addField || 'Add Field'}
        </Button>

        {availableFields.slice(0, 3).map((field) => (
          <Button key={field.name} type="button" variant="ghost" size="sm" onClick={() => addField(field.name)} className="text-xs text-muted-foreground">
            + {field.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
