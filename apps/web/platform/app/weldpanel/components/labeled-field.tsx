import type { ReactNode } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@weldsuite/ui/lib/utils';

interface LabeledFieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A label above a control, with an optional hint underneath: the builders' form rows. */
export function LabeledField({ label, htmlFor, hint, children, className }: Readonly<LabeledFieldProps>) {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
