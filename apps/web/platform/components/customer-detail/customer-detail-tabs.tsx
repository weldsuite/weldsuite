
import {
  LayoutGrid,
  SquareActivity,
  Mail,
  Phone,
  StickyNote,
  SquareCheck,
  Folder,
  SquareKanban,
  Video,
  History,
  MessagesSquare,
  Users,
} from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { useCustomerDetailContext } from './customer-detail-provider';
import { useCrmTasks } from '@/hooks/use-crm-tasks';
import { useDrawerFieldVisibility } from '@/hooks/use-drawer-field-visibility';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import type { CustomerDetailTab } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

interface CustomerDetailTabsProps {
  variant?: 'page' | 'panel' | 'embedded';
}

interface TabConfig {
  id: CustomerDetailTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  countKey?: 'contacts' | 'activities' | 'opportunities' | 'orders' | 'invoices' | 'notes' | 'tasks';
}

// Tabs to show in panel mode. The slide-in customer panel from the list page
// renders the chat as a bottom-pinned, resizable section (see
// CustomerDetailPanelLayout) — same UX as the task detail panel — rather than
// as a tab, so 'chat' is intentionally NOT included here. Capped at 3 tabs:
// Details (overview), Contacts, Activity.
const panelTabs: CustomerDetailTab[] = ['overview', 'contacts', 'activity'];

// Tabs to show in page mode (full set)
const pageTabs: CustomerDetailTab[] = ['overview', 'activity', 'contacts', 'emails', 'calls', 'deals', 'notes', 'meetings', 'tasks', 'files', 'audit'];

export function CustomerDetailTabs({ variant = 'page' }: CustomerDetailTabsProps) {
  const t = useTranslations();
  const allTabs: TabConfig[] = [
    { id: 'overview', label: t('sweep.weldcrm.customerDetailTabs.details'), icon: LayoutGrid },
    { id: 'activity', label: t('sweep.weldcrm.customerDetailTabs.activity'), icon: SquareActivity, countKey: 'activities' },
    { id: 'contacts', label: t('sweep.weldcrm.customerDetailTabs.contacts'), icon: Users, countKey: 'contacts' },
    { id: 'emails', label: t('sweep.weldcrm.customerDetailTabs.emails'), icon: Mail },
    { id: 'calls', label: t('sweep.weldcrm.customerDetailTabs.calls'), icon: Phone },
    { id: 'deals', label: t('sweep.weldcrm.customerDetailTabs.pipeline'), icon: SquareKanban, countKey: 'opportunities' },
    { id: 'notes', label: t('sweep.weldcrm.customerDetailTabs.notes'), icon: StickyNote, countKey: 'notes' },
    { id: 'meetings', label: t('sweep.weldcrm.customerDetailTabs.meetings'), icon: Video },
    { id: 'tasks', label: t('sweep.weldcrm.customerDetailTabs.tasks'), icon: SquareCheck, countKey: 'tasks' },
    { id: 'files', label: t('sweep.weldcrm.customerDetailTabs.files'), icon: Folder },
    { id: 'chat', label: t('sweep.weldcrm.customerDetailTabs.chat'), icon: MessagesSquare },
    { id: 'audit', label: t('sweep.weldcrm.customerDetailTabs.auditLog'), icon: History },
  ];
  const { activeTab, setActiveTab, data, showTabs, countOverrides, entityType, mode } = useCustomerDetailContext();
  const { user } = useUser();
  const { data: tasks = [] } = useCrmTasks(user?.id);
  const {
    isFieldVisible,
    fields: drawerFields,
    fieldVisibility: drawerFieldVisibility,
    toggleField: drawerToggleField,
    resetToDefaults: drawerResetToDefaults,
  } = useDrawerFieldVisibility('customer-detail');

  if (!showTabs) return null;

  const activeTaskCount = tasks.filter(t => t.status !== 'done').length;
  const counts = data?.counts ? { ...data.counts, tasks: activeTaskCount, ...countOverrides } : undefined;

  // Filter tabs based on variant, entity type, and user visibility preferences.
  const baseTabIds = entityType === 'contact'
    ? (variant === 'panel' ? panelTabs : ['overview', 'activity', 'emails', 'calls', 'notes', 'tasks', 'files'] as CustomerDetailTab[])
    : (variant === 'panel' ? panelTabs : pageTabs);
  const visibleTabIds = baseTabIds.filter(tabId => isFieldVisible(tabId));
  // Preserve the order from baseTabIds (e.g. panelTabs) instead of allTabs
  // so callers can dictate the tab order — important for the panel variant
  // which wants Details · Contacts · Activity in that order.
  const filteredTabs = visibleTabIds
    .map((id) => allTabs.find((t) => t.id === id))
    .filter((t): t is TabConfig => !!t);

  // Map to PageTab format. Hide the activity-count badge in the panel
  // variant — too noisy at the smaller size.
  const tabs: PageTab[] = filteredTabs.map((tab) => {
    const skipCount = variant === 'panel' && tab.id === 'activity';
    return {
      id: tab.id,
      label: tab.label,
      icon: tab.icon,
      count: !skipCount && tab.countKey ? counts?.[tab.countKey] : undefined,
    };
  });

  return (
    <PageTabs
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as CustomerDetailTab)}
      innerClassName="px-4 pt-1"
      className="group/tabs-header"
    >
      {mode !== 'panel' && (
        <div className="ml-auto flex items-center pl-2 flex-shrink-0 self-center -translate-y-[4px] opacity-0 group-hover/tabs-header:opacity-100 transition-opacity">
          <DrawerFieldSettings
            fields={drawerFields}
            fieldVisibility={drawerFieldVisibility}
            onToggle={drawerToggleField}
            onReset={drawerResetToDefaults}
            label={t('sweep.weldcrm.customerDetailTabs.visibleTabs')}
          />
        </div>
      )}
    </PageTabs>
  );
}
