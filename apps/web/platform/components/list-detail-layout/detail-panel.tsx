
import React, { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface DetailPanelProps {
  /** The detail content */
  children: ReactNode;
  /** Additional className for the container */
  className?: string;
}

function DetailPanel({ children, className }: DetailPanelProps) {
  return (
    <div className={cn("bg-white dark:bg-background/30 flex flex-col h-full overflow-hidden flex-1", className)}>
      {children}
    </div>
  );
}

interface DetailPanelEmptyStateProps {
  /** Icon to display */
  icon: LucideIcon;
  /** Title text */
  title: string;
  /** Description text */
  description?: string;
  /** Additional className */
  className?: string;
}

function DetailPanelEmptyState({
  icon: Icon,
  title,
  description,
  className,
}: DetailPanelEmptyStateProps) {
  return (
    <div className={cn("bg-white dark:bg-background/30 flex flex-col h-full overflow-hidden flex-1 items-center justify-center", className)}>
      <div className="flex flex-col items-center justify-center max-w-md text-center px-6">
        <div className="w-12 h-12 rounded-lg bg-gray-100 dark:bg-background/50 flex items-center justify-center mb-4">
          <Icon className="h-6 w-6 text-gray-400 dark:text-gray-600" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-foreground mb-2">
          {title}
        </h3>
        {description && (
          <p className="text-sm text-gray-500 dark:text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

interface DetailPanelHeaderProps {
  /** Title text */
  title: string;
  /** Subtitle text */
  subtitle?: string;
  /** Actions to display in header */
  actions?: ReactNode;
  /** Additional className */
  className?: string;
}

function DetailPanelHeader({
  title,
  subtitle,
  actions,
  className,
}: DetailPanelHeaderProps) {
  return (
    <div className={cn("px-6 py-4 border-b border-gray-100 dark:border-border", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-foreground truncate">
            {title}
          </h2>
          {subtitle && (
            <p className="text-sm text-gray-500 dark:text-muted-foreground mt-1">
              {subtitle}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

interface DetailPanelContentProps {
  /** The content */
  children: ReactNode;
  /** Additional className */
  className?: string;
  /** Padding size */
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

function DetailPanelContent({
  children,
  className,
  padding = 'md',
}: DetailPanelContentProps) {
  const paddingClasses = {
    none: '',
    sm: 'p-3',
    md: 'p-6',
    lg: 'p-8',
  };

  return (
    <div className={cn("flex-1 overflow-y-auto", paddingClasses[padding], className)}>
      {children}
    </div>
  );
}
