/** WeldHR settings — departments, lifecycle templates, leave types, evaluation forms, KPIs. */

import { Lock } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { PageTab } from '@weldsuite/ui/components/page-tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { emptyIcon, useHrBreadcrumbs, HrTabsPage } from '../components/page-kit';
import { DepartmentsTab } from './components/departments-tab';
import { TemplatesTab } from './components/templates-tab';
import { LeaveTypesTab } from './components/leave-types-tab';
import { EvaluationFormsTab } from './components/evaluation-forms-tab';
import { KpisTab } from './components/kpis-tab';

const TABS = ['departments', 'templates', 'leave-types', 'evaluation-forms', 'kpis'] as const;
type SettingsTab = (typeof TABS)[number];

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

export default function WeldHrSettingsPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const search = useSearch({ from: '/weldhr/settings/' });
  const navigate = useNavigate();

  useHrBreadcrumbs({ label: t('weldhr.settings.title') });

  if (!can('employees:manage')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        {emptyIcon(Lock)}
        <p className="text-sm font-medium">{t('weldhr.common.noPermission')}</p>
      </div>
    );
  }

  const activeTab: SettingsTab = isSettingsTab(search.tab) ? search.tab : 'departments';

  function setTab(tab: string) {
    navigate({ to: '/weldhr/settings', search: { tab: tab as SettingsTab } });
  }

  const tabs: PageTab[] = [
    { id: 'departments', label: t('weldhr.settings.tabs.departments') },
    { id: 'templates', label: t('weldhr.settings.tabs.templates') },
    { id: 'leave-types', label: t('weldhr.settings.tabs.leaveTypes') },
    { id: 'evaluation-forms', label: t('weldhr.settings.tabs.evaluationForms') },
    { id: 'kpis', label: t('weldhr.settings.tabs.kpis') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={activeTab} onTabChange={setTab}>
      {activeTab === 'departments' && <DepartmentsTab />}
      {activeTab === 'templates' && <TemplatesTab />}
      {activeTab === 'leave-types' && <LeaveTypesTab />}
      {activeTab === 'evaluation-forms' && <EvaluationFormsTab />}
      {activeTab === 'kpis' && <KpisTab />}
    </HrTabsPage>
  );
}
