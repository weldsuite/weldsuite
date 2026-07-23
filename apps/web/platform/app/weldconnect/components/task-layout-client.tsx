
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { TaskHeader } from './task-header';
import { ModuleContent } from '@/components/layout/module-content';

interface TaskLayoutClientProps {
  children: ReactNode;
}

export function TaskLayoutClient({ children }: TaskLayoutClientProps) {
  return (
    <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
      <TaskHeader />
      <ModuleContent className="overflow-auto">
        <BreadcrumbProvider>{children}</BreadcrumbProvider>
      </ModuleContent>
    </div>
  );
}
