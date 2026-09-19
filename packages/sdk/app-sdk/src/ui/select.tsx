import type { SelectHTMLAttributes } from 'react';
import { cn } from './cn';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

/** Native select styled like platform inputs. */
export function Select({ className, children, ...props }: SelectProps) {
  return (
    <select data-slot="select" className={cn('wui-select', className)} {...props}>
      {children}
    </select>
  );
}
