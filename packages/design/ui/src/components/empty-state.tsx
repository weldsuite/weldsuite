import type { ComponentType, ReactNode } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';

/** Quiet inline text for an empty list inside a card (a full list page uses its list's own empty state). */
export function EmptyText({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <p className={cn('py-6 text-center text-sm text-muted-foreground', className)}>{children}</p>;
}

export interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  /** A call to action under the text, usually a Button. */
  action?: ReactNode;
  className?: string;
}

/** An empty section with a call to action, in a dashed frame. */
export function EmptyState({ icon: Icon, title, description, action, className }: Readonly<EmptyStateProps>) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center',
        className,
      )}
    >
      {Icon && <Icon className="h-8 w-8 text-muted-foreground/60" />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
