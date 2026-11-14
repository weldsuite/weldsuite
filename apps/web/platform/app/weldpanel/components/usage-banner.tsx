/**
 * The module-wide usage banner, for people who manage WeldPanel
 * (`panel_projects:manage`): a warning at 80% of the month's allowance, a
 * notice at 100%, and an alert while data is being dropped or recordings are
 * paused. Warnings can be dismissed for the rest of the session; an alert stays.
 */

import { useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useWeldPanelUsage } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { formatPercent } from '../lib/format';
import { bannerKey, usageBanner } from '../lib/usage';

const STORAGE_PREFIX = 'weldpanel:usage-banner:';

function wasDismissed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(key: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, '1');
  } catch {
    // The banner comes back on the next page load.
  }
}

export function UsageBanner() {
  const { t, language } = useI18n();
  const tb = t.weldpanel.observe.banner;
  const canManage = useCan('panel_projects:manage');
  const { data: usage } = useWeldPanelUsage(canManage);
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (!canManage || !usage) return null;
  const banner = usageBanner(usage);
  if (!banner) return null;

  const alert = banner.kind === 'events_blocked' || banner.kind === 'replay_blocked';
  const key = bannerKey(banner, usage.month);
  if (!alert && (dismissed === key || wasDismissed(key))) return null;

  const what = 'what' in banner ? tb.what[banner.what] : '';
  const message =
    banner.kind === 'events_blocked'
      ? tb.eventsBlocked
      : banner.kind === 'replay_blocked'
        ? tb.replayBlocked
        : banner.kind === 'reached'
          ? tb.reached100.replace('{what}', what)
          : tb.warning80.replace('{percent}', formatPercent(banner.ratio, language, 0)).replace('{what}', what);

  return (
    <div className="border-b px-4 py-2" data-testid="weldpanel-usage-banner">
      <InfoBanner
        variant={alert ? 'danger' : 'warning'}
        dismissible={!alert}
        onDismiss={() => {
          rememberDismissed(key);
          setDismissed(key);
        }}
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/weldpanel/settings?tab=usage">{tb.viewUsage}</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/billing">{tb.topUp}</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/plans">{tb.upgrade}</Link>
            </Button>
          </div>
        }
      >
        {message}
      </InfoBanner>
    </div>
  );
}
