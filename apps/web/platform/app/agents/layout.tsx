import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AgentsHeader } from './components/agents-header';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * The agents module: the overview at /agents and one agent per page. The
 * module sidebar switches between agents, so the page has no list column of its
 * own (a phone goes /agents, then an agent, and back).
 */
export default function AgentsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <AgentsHeader />
        <ModuleContent className="overflow-hidden">
          <div className="flex h-full w-full overflow-hidden bg-background">{children}</div>
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
