import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AgentsHeader } from './components/agents-header';
import { AgentList } from './components/agent-list';
import { ModuleContent } from '@/components/layout/module-content';
import { ListDetailLayout } from '@/components/list-detail-layout';

export default function AgentsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <AgentsHeader />
        <ModuleContent className="overflow-hidden">
          <ListDetailLayout
            listWidth={280}
            basePath="/agents"
            list={<AgentList />}
            className="bg-background"
          >
            {children}
          </ListDetailLayout>
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
