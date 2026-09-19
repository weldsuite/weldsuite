import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** Title row used by platform module pages (title + optional actions). */
export function PageHeader({ title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <header data-slot="page-header" className={cn('wui-page-header', className)} {...props}>
      <div className="wui-page-header__titles">
        <h1 className="wui-page-header__title">{title}</h1>
        {description ? <p className="wui-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="wui-page-header__actions">{actions}</div> : null}
    </header>
  );
}

export interface PageProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
}

/** Content-area page shell for WeldApps (fills the host iframe). */
export function Page({ className, children, ...props }: PageProps) {
  return (
    <main data-slot="page" className={cn('wui-page', className)} {...props}>
      {children}
    </main>
  );
}
