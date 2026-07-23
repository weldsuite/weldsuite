import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AgentsHeader } from './components/agents-header';
import { ModuleContent } from '@/components/layout/module-content';

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <AgentsHeader />
        <ModuleContent className="overflow-y-auto overflow-x-hidden subtle-scrollbar">
          {children}
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
