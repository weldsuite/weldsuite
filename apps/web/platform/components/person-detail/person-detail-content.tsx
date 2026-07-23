
import { useState, ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';

interface StatCard {
  label: string;
  value: string | number;
}

interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface PersonDetailContentProps {
  /** Stats to display at top */
  stats?: StatCard[];
  /** Tabs with content */
  tabs?: Tab[];
  /** Default active tab ID */
  defaultTab?: string;
  /** Children to render if no tabs provided */
  children?: ReactNode;
  className?: string;
}

export function PersonDetailContent({
  stats,
  tabs,
  defaultTab,
  children,
  className,
}: PersonDetailContentProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs?.[0]?.id || '');

  return (
    <div className={`flex-1 min-w-0 ${className || ''}`}>
      {/* Stats Cards */}
      {stats && stats.length > 0 && (
        <div className="rounded-lg border border-border/60 bg-card mb-4">
          <div className="grid grid-cols-2 md:grid-cols-3 divide-x divide-border/60">
            {stats.map((stat, index) => (
              <div key={index} className={`py-3 md:py-3.5 px-3 md:px-4 ${index >= 2 ? 'col-span-2 md:col-span-1 border-t md:border-t-0 border-border/60' : ''}`}>
                <p className="text-xs md:text-sm font-medium text-muted-foreground mb-1">{stat.label}</p>
                <p className="text-base md:text-lg font-semibold">{stat.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      {tabs && tabs.length > 0 && (
        <>
          <div className="flex gap-2 mb-4">
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                variant="ghost"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 h-8 text-sm font-medium rounded-md transition-colors border ${
                  activeTab === tab.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted border-border'
                }`}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          {/* Tab Content */}
          {tabs.find((tab) => tab.id === activeTab)?.content}
        </>
      )}

      {/* Children (if no tabs) */}
      {!tabs && children}
    </div>
  );
}
