import { ArrowLeft } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { AiUnavailable } from '@/components/ai/ai-unavailable';

// AI has been removed platform-wide. The agent editor (system prompt, tools,
// triggers, usage, sub-agents) used to live on this page. The route stays
// mounted so links from the agents list don't 404 — it now just shows the
// shared unavailable state instead of calling the agents API.
export default function AgentDetailPage() {
  const t = getTranslations('common');
  useBreadcrumbs([{ label: t.agents.pageTitle, href: '/agents' }]);
  const router = useRouter();

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-14 border-b flex-shrink-0">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => router.push('/agents')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>
      <AiUnavailable />
    </div>
  );
}
