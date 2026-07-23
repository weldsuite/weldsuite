import { ReactNode } from 'react';

export interface EntitySectionCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}

export function EntitySectionCard({
  title,
  description,
  children,
  actions,
}: EntitySectionCardProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-base">{title}</h3>
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
        {actions && <div>{actions}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
