import type { TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

/** Suite-styled textarea. */
export function Textarea({ className, ...props }: TextareaProps) {
  return <textarea data-slot="textarea" className={cn('wui-textarea', className)} {...props} />;
}
