import { LucideIcon } from 'lucide-react';
import { ReactNode } from 'react';

export interface InfoItem {
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
  href?: string;
}

export interface EntityInfoCardProps {
  title: string;
  description?: string;
  items: InfoItem[];
  children?: ReactNode;
}

export function EntityInfoCard({ title, description, items, children }: EntityInfoCardProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">
          {title}
        </h3>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      <div className="space-y-3">
        {items.map((item, index) => {
          const Icon = item.icon;
          const content = (
            <div
              key={index}
              className="flex items-center justify-between py-2.5 border-b last:border-0"
            >
              <div className="flex items-center gap-2.5">
                {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                <span className="text-sm text-muted-foreground">{item.label}</span>
              </div>
              <div className="text-sm font-medium text-right">{item.value}</div>
            </div>
          );

          if (item.href) {
            return (
              <a
                key={index}
                href={item.href}
                className="block hover:text-primary transition-colors"
              >
                {content}
              </a>
            );
          }

          return content;
        })}
        {children}
      </div>
    </div>
  );
}
