import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { DriveHeader } from './drive-header';
import { ModuleContent } from '@/components/layout/module-content';

interface DriveLayoutClientProps {
  children: ReactNode;
}

export function DriveLayoutClient({ children }: DriveLayoutClientProps) {
  return (
    <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
      <DriveHeader />
      <ModuleContent className="overflow-auto">
        <BreadcrumbProvider>{children}</BreadcrumbProvider>
      </ModuleContent>
    </div>
  );
}
