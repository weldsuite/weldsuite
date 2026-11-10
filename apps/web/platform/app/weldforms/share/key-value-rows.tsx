/**
 * Editable name/value rows for hidden fields and prefilled answers. The name
 * input offers the known names (question references, hidden fields) as
 * suggestions but takes any valid name.
 */

import { useId } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import type { HiddenFieldValue } from './embed-snippet';

export interface KeyValueRowsLabels {
  name: string;
  value: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  add: string;
  remove: string;
  suggestions: string;
}

export function KeyValueRows({
  rows,
  onChange,
  suggestions,
  labels,
}: Readonly<{
  rows: HiddenFieldValue[];
  onChange: (rows: HiddenFieldValue[]) => void;
  suggestions: string[];
  labels: KeyValueRowsLabels;
}>) {
  const listId = useId();

  const update = (index: number, patch: Partial<HiddenFieldValue>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2">
      {suggestions.length > 0 && (
        <datalist id={listId} aria-label={labels.suggestions}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            list={suggestions.length > 0 ? listId : undefined}
            value={row.name}
            onChange={(e) => update(index, { name: e.target.value })}
            placeholder={labels.namePlaceholder}
            aria-label={labels.name}
            className="min-w-0 flex-1"
            autoComplete="off"
          />
          <Input
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            placeholder={labels.valuePlaceholder}
            aria-label={labels.value}
            className="min-w-0 flex-1"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={labels.remove}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { name: '', value: '' }])}>
        <Plus className="mr-1.5 h-4 w-4" />
        {labels.add}
      </Button>
    </div>
  );
}
