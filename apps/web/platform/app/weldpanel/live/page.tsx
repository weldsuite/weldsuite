/**
 * Live: who is on the site right now. The Overview links here; the panel
 * itself is `LivePanel`. No title row and no cards: full-width sections from
 * edge to edge, the map first; the page name is in the breadcrumb (and a
 * heading for screen readers).
 */

import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { LivePanel } from './live-panel';

export default function LivePage() {
  const { t } = useI18n();
  const tl = t.weldpanel.observe.live;
  useBreadcrumbs([{ label: t.weldpanel.breadcrumb.home, href: '/weldpanel' }, { label: tl.title }]);
  return (
    <AnalyticsPage title={tl.title} description={tl.description} bare>
      {(project) => (
        <div className="h-full overflow-y-auto bg-background">
          <h1 className="sr-only">{tl.title}</h1>
          <LivePanel key={project.id} projectId={project.id} />
        </div>
      )}
    </AnalyticsPage>
  );
}
