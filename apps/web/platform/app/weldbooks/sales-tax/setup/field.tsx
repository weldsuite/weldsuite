import type { ReactNode } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';

export interface FieldProps {
  label: ReactNode;
  /** The `id` of the control the label belongs to. */
  htmlFor?: string;
  help?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}

/** A label, its control, a line of help and the validation error, laid out the same on every setup form. */
export function Field({ label, htmlFor, help, error, className, children }: Readonly<FieldProps>) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? (
        <p id={htmlFor ? `${htmlFor}-help` : undefined} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The `aria-describedby` of a control inside a `Field`. */
export function describedBy(id: string, parts: { help?: boolean; error?: boolean }): string | undefined {
  const ids = [parts.help ? `${id}-help` : null, parts.error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
