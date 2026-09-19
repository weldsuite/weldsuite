import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** Suite-styled text input. */
export function Input({ className, type = 'text', ...props }: InputProps) {
  return <input type={type} data-slot="input" className={cn('wui-input', className)} {...props} />;
}
