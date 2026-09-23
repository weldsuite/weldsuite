/**
 * WeldHR — on- & offboarding board.
 *
 * Three tabs: checklists in flight for onboarding, for offboarding, and a
 * history of completed/cancelled checklists. Starting a checklist here
 * materialises real tasks from a template (see `services/weldhr/lifecycle.ts`).
 */

import { useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useHrChecklists } from '@/hooks/queries/use-weldhr-queries';
import { EmptyState, ErrorBanner, InlineSpinner, PageBody, PageHeader, errorMessage } from '../components/shared';
import { ChecklistCard } from './components/checklist-card';
import { StartChecklistDialog } from './components/start-checklist-dialog';

type Tab = 'onboarding' | 'offboarding' | 'completed';

export default function WeldHrLifecyclePage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const search = useSearch({ from: '/weldhr/lifecycle/' }) as { tab?: string };
  const tab: Tab = search.tab === 'offboarding' || search.tab === 'completed' ? search.tab : 'onboarding';

  const [starting, setStarting] = useState<'onboarding' | 'offboarding' | null>(null);
  const canWrite = can('employees:update');

  const params =
    tab === 'completed' ? { status: 'completed,cancelled' } : { kind: tab, status: 'in_progress' };
  const { data: checklists, isLoading, error } = useHrChecklists(params);

  function setTab(next: Tab) {
    void navigate({ to: '/weldhr/lifecycle', search: { tab: next }, replace: true });
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'onboarding', label: t('weldhr.lifecycle.tabs.onboarding') },
    { id: 'offboarding', label: t('weldhr.lifecycle.tabs.offboarding') },
    { id: 'completed', label: t('weldhr.lifecycle.tabs.completed') },
  ];

  return (
    <PageBody wide>
      <PageHeader
        title={t('weldhr.lifecycle.title')}
        subtitle={t('weldhr.lifecycle.subtitle')}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/weldhr/settings" search={{ tab: 'templates' }}>
                <Settings className="mr-1.5 h-4 w-4" />
                {t('weldhr.lifecycle.manageTemplates')}
              </Link>
            </Button>
            {canWrite && tab !== 'completed' && (
              <Button size="sm" onClick={() => setStarting(tab)}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldhr.lifecycle.startChecklist.action')}
              </Button>
            )}
          </>
        }
      />

      <div className="flex gap-1 border-b">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === item.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.lifecycle.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !checklists || checklists.length === 0 ? (
        <EmptyState
          title={t(`weldhr.lifecycle.empty.${tab}.title`)}
          description={t(`weldhr.lifecycle.empty.${tab}.description`)}
          action={
            canWrite && tab !== 'completed' ? (
              <Button onClick={() => setStarting(tab)}>{t('weldhr.lifecycle.startChecklist.action')}</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {checklists.map((checklist) => (
            <ChecklistCard key={checklist.id} checklist={checklist} />
          ))}
        </div>
      )}

      {starting && <StartChecklistDialog kind={starting} onClose={() => setStarting(null)} />}
    </PageBody>
  );
}
