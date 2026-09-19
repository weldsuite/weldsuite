import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  children?: ReactNode;
}

const variantClass: Record<BadgeVariant, string> = {
  default: 'wui-badge--default',
  secondary: 'wui-badge--secondary',
  outline: 'wui-badge--outline',
  destructive: 'wui-badge--destructive',
  success: 'wui-badge--success',
  warning: 'wui-badge--warning',
};

/** Status / label chip (platform Badge). */
export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn('wui-badge', variantClass[variant], className)} {...props} />
  );
}
