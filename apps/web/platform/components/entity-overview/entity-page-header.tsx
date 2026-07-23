import { Button } from "@weldsuite/ui/components/button";
import { LucideIcon } from "lucide-react";
import { Link } from '@/lib/router';
import React, { ReactNode } from "react";

export interface StatItem {
  icon: LucideIcon;
  label: string;
  count?: number;
  value?: string;
  color?: string;
  show?: boolean;
}

export interface ActionButton {
  label: string;
  icon?: LucideIcon;
  href?: string;
  onClick?: () => void;
  variant?: "default" | "outline" | "ghost";
  /**
   * Stable test selector for Playwright. Pass an explicit slug
   * (e.g. `"create-variable"`) so the testid stays locale-stable —
   * `label` is translated and would change per language. When
   * omitted, the button has no testid and specs need to find it via
   * another locator.
   */
  testId?: string;
}

interface EntityPageHeaderProps {
  title: string;
  description?: string;
  titlePrefix?: ReactNode;
  stats?: StatItem[];
  actions?: ActionButton[];
  extraActions?: ReactNode;
  children?: ReactNode;
  maxWidth?: string;
}

export function EntityPageHeader({ title, description, titlePrefix, stats = [], actions = [], extraActions, children, maxWidth = "1600px" }: EntityPageHeaderProps) {
  return (
    <div className="min-h-full bg-background">
      <div className="container mx-auto p-4 md:p-8 space-y-4 md:space-y-8" style={{ maxWidth }}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="hidden md:flex text-3xl font-bold tracking-tight items-center gap-3">
              {titlePrefix}
              {title}
            </h1>
            {description && (
              <p className="text-sm text-muted-foreground mt-1">
                {description}
              </p>
            )}
            {stats.length > 0 && (
              <div className="hidden md:flex items-center gap-6 mt-3">
                <div className="flex items-center gap-4 text-sm">
                  {stats
                    .filter((stat) => stat.show !== false)
                    .map((stat, index, arr) => (
                      <React.Fragment key={stat.label}>
                        {index > 0 && <span className="text-muted-foreground">•</span>}
                        <span
                          className={`flex items-center gap-1 ${stat.color || ""}`}
                        >
                          <stat.icon className={`h-4 w-4 ${stat.color || ""}`} />
                          <span className="font-medium">{stat.value ?? stat.count}</span> {stat.label}
                        </span>
                      </React.Fragment>
                    ))}
                </div>
              </div>
            )}
          </div>
          {(actions.length > 0 || extraActions) && (
            <div className="flex items-center gap-2">
              {extraActions}
              {actions.map((action) => {
                const ButtonContent = (
                  <Button
                    variant={action.variant || "outline"}
                    className="h-8 text-sm px-3 flex items-center gap-2 shadow-none"
                    onClick={action.onClick}
                    data-testid={
                      action.testId
                        ? `page-header-action-${action.testId}`
                        : undefined
                    }
                  >
                    {action.icon && <action.icon className="h-4 w-4 -mr-0.5" />}
                    {action.label}
                  </Button>
                );

                if (action.href) {
                  return (
                    <Link key={action.label} href={action.href}>
                      {ButtonContent}
                    </Link>
                  );
                }

                return <div key={action.label}>{ButtonContent}</div>;
              })}
            </div>
          )}
        </div>

        {/* Content (typically the table) */}
        {children}
      </div>
    </div>
  );
}
