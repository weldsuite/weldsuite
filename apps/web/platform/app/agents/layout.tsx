import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { AgentsHeader } from './components/agents-header';
import { AgentsBotList } from './components/agents-bot-list';
import { ModuleContent } from '@/components/layout/module-content';
import { ListDetailLayout } from '@/components/list-detail-layout';

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <AgentsHeader />
        <ModuleContent className="overflow-hidden">
          <ListDetailLayout
            listWidth={340}
            basePath="/agents"
            list={<AgentsBotList />}
            className="bg-background"
          >
            {children}
          </ListDetailLayout>
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
