'use client';

import * as React from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Badge } from '@weldsuite/ui/components/badge';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CustomFieldDefinition } from '@/hooks/use-custom-fields';

/**
 * One form control per custom-field type.
 *
 * Shared by the create dialog and the record detail editor so a field renders
 * and coerces identically in both — a value typed in one place and edited in
 * the other must round-trip through the same code, or the two drift on things
 * like empty-string-versus-null.
 */

interface FieldInputProps {
  field: CustomFieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}

export function FieldInput({ field, value, onChange, disabled }: FieldInputProps) {
  switch (field.fieldType) {
    case 'textarea':
      return (
        <Textarea
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={4}
        />
      );

    case 'number':
    case 'currency':
      return (
        <Input
          type="number"
          value={value === null || value === undefined ? '' : String(value)}
          // Empty string clears the value rather than becoming NaN — the API
          // treats null as "clear this field".
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          disabled={disabled}
        />
      );

    case 'rating': {
      const current = typeof value === 'number' ? value : 0;
      return (
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              disabled={disabled}
              // Clicking the current rating clears it — otherwise a rating set
              // by mistake can never be unset.
              onClick={() => onChange(current === n ? null : n)}
              className="rounded p-0.5 transition-colors hover:bg-muted disabled:opacity-50"
              aria-label={`${n}`}
            >
              <Star
                className={cn(
                  'h-5 w-5',
                  n <= current ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
                )}
              />
            </button>
          ))}
        </div>
      );
    }

    case 'boolean':
      return (
        <Checkbox
          checked={!!value}
          onCheckedChange={(checked) => onChange(!!checked)}
          disabled={disabled}
        />
      );

    case 'date':
      return (
        <Input
          type="date"
          // Values arrive as ISO timestamps; <input type="date"> wants the date
          // part only.
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          disabled={disabled}
        />
      );

    case 'single_select':
      return (
        <Select
          value={(value as string) ?? ''}
          onValueChange={(next) => onChange(next === '__clear__' ? null : next)}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {!field.required ? <SelectItem value="__clear__">—</SelectItem> : null}
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case 'multi_select': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {(field.options ?? []).map((option) => {
            const isOn = selected.includes(option.value);
            return (
              <Badge
                key={option.value}
                variant={isOn ? 'default' : 'outline'}
                className={cn('cursor-pointer select-none', disabled && 'pointer-events-none opacity-50')}
                onClick={() =>
                  onChange(
                    isOn
                      ? selected.filter((v) => v !== option.value)
                      : [...selected, option.value],
                  )
                }
              >
                {option.label}
              </Badge>
            );
          })}
        </div>
      );
    }

    case 'email':
      return (
        <Input
          type="email"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );

    case 'url':
      return (
        <Input
          type="url"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="https://"
        />
      );

    case 'phone':
      return (
        <Input
          type="tel"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );

    default:
      return (
        <Input
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );
  }
}

/** A labelled field row, grouped by the definition's `group` where present. */
export function FieldRow({
  field,
  value,
  onChange,
  disabled,
}: FieldInputProps) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-sm">
        {field.name}
        {field.required ? <span className="text-destructive">*</span> : null}
      </Label>
      <FieldInput field={field} value={value} onChange={onChange} disabled={disabled} />
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}

/** Group definitions by their `group`, preserving each group's field order. */
export function groupFields(
  fields: CustomFieldDefinition[],
): Array<{ group: string | null; fields: CustomFieldDefinition[] }> {
  const groups = new Map<string, CustomFieldDefinition[]>();
  const ungrouped: CustomFieldDefinition[] = [];

  for (const field of [...fields].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
    if (!field.group) {
      ungrouped.push(field);
      continue;
    }
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }

  return [
    ...(ungrouped.length > 0 ? [{ group: null, fields: ungrouped }] : []),
    ...[...groups.entries()].map(([group, groupFieldList]) => ({
      group,
      fields: groupFieldList,
    })),
  ];
}
