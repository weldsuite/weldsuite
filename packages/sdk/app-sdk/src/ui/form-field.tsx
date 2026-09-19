import type { FormHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Label } from './label';

export interface FormFieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Label + control + optional hint/error. */
export function FormField({ label, htmlFor, hint, error, className, children }: FormFieldProps) {
  return (
    <div className={cn('wui-field', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error ? <p className="wui-field__hint">{hint}</p> : null}
      {error ? <p className="wui-field__error">{error}</p> : null}
    </div>
  );
}

export function FormFieldRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('wui-field-row', className)}>{children}</div>;
}

export function Form({ children, className, ...props }: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form data-slot="form" className={cn('wui-form', className)} {...props}>
      {children}
    </form>
  );
}

export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('wui-form__actions', className)}>{children}</div>;
}
