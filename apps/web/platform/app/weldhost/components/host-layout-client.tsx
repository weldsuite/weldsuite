
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { HostHeader } from './host-header';
import { ModuleContent } from '@/components/layout/module-content';

interface HostLayoutClientProps {
  children: ReactNode;
}

export function HostLayoutClient({ children }: HostLayoutClientProps) {
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <HostHeader />
        <ModuleContent className="overflow-auto">{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
