import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type AlertVariant = 'default' | 'destructive' | 'success';

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  children?: ReactNode;
}

const variantClass: Record<AlertVariant, string> = {
  default: '',
  destructive: 'wui-alert--destructive',
  success: 'wui-alert--success',
};

/** Inline status / error banner. */
export function Alert({ variant = 'default', className, role = 'alert', ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn('wui-alert', variantClass[variant], className)}
      {...props}
    />
  );
}
