import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import type { ActiveFilter } from '@/components/panel-entity-list';
import { MY_HR_PATHS } from '../../access';
import { HrTabsPage } from '../../components/page-kit';
import { MyDeclarationDialog } from '../components/declaration-dialog';
import { MyDeclarationsList } from '../components/declarations-tab';
import { useMyHrSelf } from '../components/my-hr-context';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';
import { MyPayoutsList, payoutFilters } from '../components/payouts-tab';

type Tab = 'declarations' | 'payouts';

/**
 * My HR → Expenses: your declarations, and what is still to be paid out and
 * what was paid out (Payouts), a tab each, in the standard lists.
 */
export default function MyExpensesPage() {
  const t = useTranslations();
  const { features } = useMyHrSelf();
  const [tab, setTab] = useState<Tab>('declarations');
  // The Declarations tab's filters live here, so a Payouts row can open it filtered.
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [creating, setCreating] = useState(false);
  useMyHrBreadcrumbs(t('weldhr.me.pages.expenses'));
  // A row opens its details panel; the URL keeps it (`?stack=`), so a link or reload reopens it.
  useObjectPanelUrlSync(MY_HR_PATHS.expenses);

  const tabs = [
    { id: 'declarations', label: t('weldhr.me.declarations.tabs.declarations') },
    { id: 'payouts', label: t('weldhr.me.declarations.tabs.payouts') },
  ];
  const newDeclaration = features.declarations ? () => setCreating(true) : undefined;

  return (
    <>
      <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={(next) => setTab(next as Tab)}>
        {tab === 'declarations' && (
          <MyDeclarationsList
            canSubmit={features.declarations}
            onNewDeclaration={() => setCreating(true)}
            activeFilters={filters}
            onFiltersChange={setFilters}
          />
        )}
        {tab === 'payouts' && (
          <MyPayoutsList
            onNewDeclaration={newDeclaration}
            onOpenRow={(row) => {
              setFilters(payoutFilters(row));
              setTab('declarations');
            }}
          />
        )}
      </HrTabsPage>

      {creating && <MyDeclarationDialog onClose={() => setCreating(false)} />}
    </>
  );
}
