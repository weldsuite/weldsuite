import { CreditCard, Layers, Receipt } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { UsOnlyGate } from '@/app/weldbooks/payment-runs/components/payment-runs-frame';
import DimensionsPage from './dimensions/page';
import PaymentSettingsListPage from './payment-runs/page';
import SalesTaxEngineSettingsPage from './sales-tax/page';
import { WeldbooksSettingsScope } from './entity-scope';

const TABS = ['dimensions', 'sales-tax', 'payment-runs'] as const;
type WeldbooksSettingsTab = (typeof TABS)[number];

function isTab(value: string | undefined): value is WeldbooksSettingsTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

function WeldbooksSettingsTabs() {
  const { t } = useI18n();
  const tt = t.weldbooksUs.settingsPage.tabs;
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const { features, isResolved, isError } = useCurrentJurisdiction();

  // Sales tax and payment runs are US screens, as in the WeldBooks menu: hidden until the jurisdiction says so.
  const usTabs = isResolved && !isError && features.salesTax;
  const requested: WeldbooksSettingsTab = isTab(search.tab) ? search.tab : 'dimensions';
  const waiting = requested !== 'dimensions' && !isResolved && !isError;
  const activeTab: WeldbooksSettingsTab = requested === 'dimensions' || usTabs ? requested : 'dimensions';

  function setTab(tab: string) {
    navigate({ to: '/settings/apps/weldbooks', search: tab === 'dimensions' ? {} : { tab } });
  }

  const tabs: PageTab[] = [
    { id: 'dimensions', label: tt.dimensions, icon: Layers },
    ...(usTabs
      ? [
          { id: 'sales-tax', label: tt.salesTax, icon: Receipt },
          { id: 'payment-runs', label: tt.paymentRuns, icon: CreditCard },
        ]
      : []),
  ];

  if (waiting) return <PageLoader fullScreen={false} />;

  return (
    <>
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setTab} overflow="dropdown" />
      <div className="@container mt-6 min-w-0">
        {activeTab === 'dimensions' && (
          <div className="h-[640px] overflow-hidden rounded-lg border">
            <DimensionsPage />
          </div>
        )}
        {activeTab === 'sales-tax' && <SalesTaxEngineSettingsPage />}
        {activeTab === 'payment-runs' && (
          <UsOnlyGate>
            <PaymentSettingsListPage />
          </UsOnlyGate>
        )}
      </div>
    </>
  );
}

/** Settings → Apps → WeldBooks: dimensions, the US sales tax engine and vendor payment settings. */
export default function WeldbooksSettingsPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.settingsPage;

  return (
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tp.title}</h1>
        <p className="text-muted-foreground">{tp.description}</p>
      </div>
      <WeldbooksSettingsScope>
        <WeldbooksSettingsTabs />
      </WeldbooksSettingsScope>
    </div>
  );
}
