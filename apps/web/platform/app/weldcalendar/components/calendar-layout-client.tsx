
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { CalendarHeader } from './calendar-header';
import { ModuleContent } from '@/components/layout/module-content';

interface CalendarLayoutClientProps {
  children: ReactNode;
}

export function CalendarLayoutClient({ children }: CalendarLayoutClientProps) {
  return (
    <div className="flex-1 flex flex-col w-full min-h-0 overflow-hidden">
      <CalendarHeader />
      <ModuleContent>
        <BreadcrumbProvider>{children}</BreadcrumbProvider>
      </ModuleContent>
    </div>
  );
}
