
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { ConnectHeader } from './connect-header';
import { ModuleContent } from '@/components/layout/module-content';

interface ConnectLayoutClientProps {
  children: ReactNode;
}

export function ConnectLayoutClient({ children }: ConnectLayoutClientProps) {
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <ConnectHeader />
        <ModuleContent className="overflow-y-auto overflow-x-hidden px-3 md:px-4 pt-3 md:pt-4 subtle-scrollbar">
          {children}
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
