import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

/** Centered empty list state (platform EntityList empty). */
export function EmptyState({ title, description, icon, action, className, ...props }: EmptyStateProps) {
  return (
    <div data-slot="empty-state" className={cn('wui-empty', className)} {...props}>
      {icon ? <div className="wui-empty__icon">{icon}</div> : null}
      <p className="wui-empty__title">{title}</p>
      {description ? <p className="wui-empty__description">{description}</p> : null}
      {action ? <div className="wui-empty__action">{action}</div> : null}
    </div>
  );
}
