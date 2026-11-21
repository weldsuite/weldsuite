/**
 * WeldStash settings (Settings > Apps > WeldStash): replenishment's settings
 * and the sales history CSV import. They live here, not in WeldStash itself
 * (AGENTS.md, "App settings live in Settings"). Replenishment is served by the
 * Rust backend only, so on Global the page says it is not available.
 */

import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { isFeatureAvailable } from '@/lib/edition';
import { getTranslations } from '@/lib/i18n';
import { SettingsTab } from './settings-tab';

export default function WeldStashSettingsPage() {
  const ts = getTranslations('weldstashReplenishment').settingsPage;
  if (!isFeatureAvailable('stash-replenishment')) return <EditionUnavailablePage />;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>
      <SettingsTab />
    </div>
  );
}
