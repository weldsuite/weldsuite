import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { AiUnavailable } from '@/components/ai/ai-unavailable';

// AI has been removed platform-wide. The Autonomous Agents module (create,
// configure, run, and monitor AI agents) used to live on this page. The
// route stays mounted so the sidebar link and any bookmarks don't 404 — it
// now just shows the shared unavailable state instead of calling the agents
// API.
export default function AgentsPage() {
  const t = getTranslations('common');
  useBreadcrumbs([{ label: t.agents.pageTitle }]);

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <AiUnavailable />
    </div>
  );
}
