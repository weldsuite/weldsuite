/** WeldHR settings — departments, lifecycle templates, leave types, evaluation forms, KPIs. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { EmptyState, PageBody, PageHeader } from '../components/shared';
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

  if (!can('employees:manage')) {
    return (
      <PageBody>
        <EmptyState title={t('weldhr.common.noPermission')} />
      </PageBody>
    );
  }

  const activeTab: SettingsTab = isSettingsTab(search.tab) ? search.tab : 'departments';

  function setTab(tab: SettingsTab) {
    navigate({ to: '/weldhr/settings', search: { tab } });
  }

  return (
    <PageBody wide>
      <PageHeader title={t('weldhr.settings.title')} subtitle={t('weldhr.settings.subtitle')} />

      <Tabs value={activeTab} onValueChange={(v) => setTab(v as SettingsTab)}>
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="departments">{t('weldhr.settings.tabs.departments')}</TabsTrigger>
          <TabsTrigger value="templates">{t('weldhr.settings.tabs.templates')}</TabsTrigger>
          <TabsTrigger value="leave-types">{t('weldhr.settings.tabs.leaveTypes')}</TabsTrigger>
          <TabsTrigger value="evaluation-forms">{t('weldhr.settings.tabs.evaluationForms')}</TabsTrigger>
          <TabsTrigger value="kpis">{t('weldhr.settings.tabs.kpis')}</TabsTrigger>
        </TabsList>

        <TabsContent value="departments" className="pt-4">
          <DepartmentsTab />
        </TabsContent>
        <TabsContent value="templates" className="pt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="leave-types" className="pt-4">
          <LeaveTypesTab />
        </TabsContent>
        <TabsContent value="evaluation-forms" className="pt-4">
          <EvaluationFormsTab />
        </TabsContent>
        <TabsContent value="kpis" className="pt-4">
          <KpisTab />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}
