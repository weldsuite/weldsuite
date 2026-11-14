/** Live: who is on the site right now. The Overview links here; the panel itself is `LivePanel`. */

import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsPage } from '../components/analytics-page';
import { LivePanel } from './live-panel';

export default function LivePage() {
  const { t } = useI18n();
  const tl = t.weldpanel.observe.live;
  return (
    <AnalyticsPage title={tl.title} description={tl.description}>
      {(project) => <LivePanel key={project.id} projectId={project.id} />}
    </AnalyticsPage>
  );
}
