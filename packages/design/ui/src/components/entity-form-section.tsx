import { ReactNode } from 'react';

export interface EntityFormSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function EntityFormSection({ title, description, children }: EntityFormSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-base">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}
