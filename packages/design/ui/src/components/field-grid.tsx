import type { ReactNode } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface FieldGridField {
  label: string;
  /** `null`/`undefined` render as an em dash. */
  value: ReactNode;
}

export interface FieldGridProps {
  fields: FieldGridField[];
  className?: string;
}

/** Label/value pairs in a record's details card: two columns from `sm` up. */
export function FieldGrid({ fields, className }: Readonly<FieldGridProps>) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4 sm:grid-cols-2', className)}>
      {fields.map((field) => (
        <div key={field.label} className="space-y-1">
          <dt className="text-xs text-muted-foreground">{field.label}</dt>
          <dd className="text-sm">{field.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
