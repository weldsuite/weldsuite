
import { ReactNode } from 'react';
import { DashboardHeader } from './dashboard-header';
import { ModuleContent } from '@/components/layout/module-content';

interface DashboardLayoutClientProps {
  children: ReactNode;
}

export function DashboardLayoutClient({ children }: DashboardLayoutClientProps) {
  return (
    <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
      <DashboardHeader />
      <ModuleContent className="overflow-auto subtle-scrollbar">{children}</ModuleContent>
    </div>
  );
}
