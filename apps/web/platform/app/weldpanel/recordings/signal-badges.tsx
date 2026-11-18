/** The frustration counts of a session as soft badges: orange for signals, red for errors. */

import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import { sessionSignals } from '../lib/people';

export function SignalBadges({ session }: Readonly<{ session: PanelSessionRow }>) {
  const { t, language } = useI18n();
  const ts = t.weldpanel.observe.recordings.signals;
  const signals = sessionSignals(session);
  if (signals.length === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {signals.map(({ key, count }) => (
        <SoftBadge key={key} tone={key === 'errors' ? 'danger' : 'warning'} className="whitespace-nowrap">
          {new Intl.NumberFormat(language).format(count)} {ts[key]}
        </SoftBadge>
      ))}
    </div>
  );
}
