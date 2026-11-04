import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { cn } from '@weldsuite/ui/lib/utils';

export interface SectionCardProps {
  title: ReactNode;
  /** A line of muted text under the title. */
  description?: ReactNode;
  /** A button or link at the right of the title row. Wraps under the title when the card is narrow. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * A titled card section on a dashboard, record or settings page: a `text-base`
 * title (with an optional description), an optional action on the right, then
 * the content.
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: Readonly<SectionCardProps>) {
  return (
    <Card className={className}>
      <CardHeader
        className={cn(
          'flex flex-row flex-wrap justify-between gap-x-4 gap-y-2 space-y-0 pb-3',
          description ? 'items-start' : 'items-center',
        )}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
