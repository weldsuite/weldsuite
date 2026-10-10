import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface DescriptionListProps {
  children: ReactNode;
  className?: string;
}

export function DescriptionList({ children, className }: Readonly<DescriptionListProps>) {
  return (
    <dl data-slot="description-list" className={cn('wui-dl', className)}>
      {children}
    </dl>
  );
}

export function DescriptionItem({
  term,
  children,
  className,
}: Readonly<{
  term: ReactNode;
  children: ReactNode;
  className?: string;
}>) {
  return (
    <div className={cn('wui-dl__row', className)}>
      <dt className="wui-dl__term">{term}</dt>
      <dd className="wui-dl__detail">{children}</dd>
    </div>
  );
}

export function Code({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <code className={cn('wui-code', className)}>{children}</code>;
}

export function Stack({ className, ...props }: Readonly<HTMLAttributes<HTMLDivElement>>) {
  return <div className={cn('wui-stack', className)} {...props} />;
}

export function Muted({ className, ...props }: Readonly<HTMLAttributes<HTMLParagraphElement>>) {
  return <p className={cn('wui-muted', className)} {...props} />;
}

export function LoadingState({ label = 'Loading…' }: Readonly<{ label?: string }>) {
  return (
    <output className="wui-loading">
      <span className="wui-spinner" aria-hidden="true" />
      <span>{label}</span>
    </output>
  );
}
