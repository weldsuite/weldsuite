import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** List filter / action bar. */
export function Toolbar({ className, ...props }: ToolbarProps) {
  return <div data-slot="toolbar" className={cn('wui-toolbar', className)} {...props} />;
}
