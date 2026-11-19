/**
 * WeldStash replenishment: what to buy today. Served by the Rust backend only
 * (Kubernetes editions); on Global the page is the "not available in this
 * edition" page, since its API would answer 404.
 *
 * Replenishment is off until a workspace turns it on (`replenishmentEnabled`);
 * until then the page is the enable screen.
 */

import { Suspense } from 'react';
import { useRouter } from '@/lib/router';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { getTranslations } from '@/lib/i18n';
import { isFeatureAvailable } from '@/lib/edition';
import { useReplenishmentSettings } from '@/hooks/queries/use-replenishment-queries';
import { AllItemsTab } from './components/all-items-tab';
import { EnableScreen } from './components/enable-screen';
import { PlanPanel } from './components/plan-panel';
import { ReorderTab } from './components/reorder-tab';
import { RunStatus } from './components/run-status';
import { openWeldStashSettings } from './lib/open-settings';

type TabId = 'reorder' | 'items';
const TABS: readonly TabId[] = ['reorder', 'items'];

function ReplenishmentContent() {
  const t = getTranslations('weldstashReplenishment');
  const settings = useReplenishmentSettings();
  const navigate = useNavigate();
  const router = useRouter();
  // Settings and the CSV import live in Settings > Apps > WeldStash (AGENTS.md).
  const openSettings = () => openWeldStashSettings(router);
  const search = useSearch({ strict: false }) as { tab?: string; plan?: string };
  const tab: TabId = TABS.includes(search.tab as TabId) ? (search.tab as TabId) : 'reorder';
  const planId = search.plan ?? null;

  const setSearch = (patch: { tab?: TabId; plan?: string | undefined }) =>
    void navigate({
      to: '.',
      replace: true,
      search: ((previous: Record<string, unknown>) => ({ ...previous, ...patch })) as never,
    });

  if (settings.isLoading) return <PageLoader fullScreen={false} />;
  if (settings.isError || !settings.data) {
    return (
      <div className="p-6">
        <ErrorState
          message={(settings.error as Error)?.message || t.page.loadError}
          onRetry={() => void settings.refetch()}
          retryLabel={t.page.retry}
        />
      </div>
    );
  }
  if (!settings.data.replenishmentEnabled) return <div className="h-full overflow-y-auto"><EnableScreen onOpenSettings={openSettings} /></div>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
        <h1 className="text-lg font-semibold">{t.page.title}</h1>
        <div className="flex items-center gap-3">
          <RunStatus />
          <Button size="sm" variant="ghost" onClick={openSettings}>
            <Settings className="mr-1 size-4" />
            {t.page.openSettings}
          </Button>
        </div>
      </div>
      <PageTabs
        className="mt-2 px-4"
        tabs={[
          { id: 'reorder', label: t.tabs.reorder },
          { id: 'items', label: t.tabs.items },
        ]}
        activeTab={tab}
        onTabChange={(id) => setSearch({ tab: id as TabId })}
      />
      <div className="min-h-0 flex-1">
        {tab === 'reorder' && (
          <ReorderTab onOpenPlan={(id) => setSearch({ plan: id })} onOpenSettings={openSettings} />
        )}
        {tab === 'items' && (
          <AllItemsTab onOpenPlan={(id) => setSearch({ plan: id })} onOpenSettings={openSettings} />
        )}
      </div>
      <PlanPanel planId={planId} onClose={() => setSearch({ plan: undefined })} />
    </div>
  );
}

export default function WeldStashReplenishmentPage() {
  if (!isFeatureAvailable('stash-replenishment')) return <EditionUnavailablePage />;
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <ReplenishmentContent />
    </Suspense>
  );
}
