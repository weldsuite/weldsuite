import type { LabelHTMLAttributes } from 'react';
import { cn } from './cn';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

/** Form label. */
export function Label({ className, htmlFor, ...props }: LabelProps) {
  return <label data-slot="label" htmlFor={htmlFor} className={cn('wui-label', className)} {...props} />;
}
