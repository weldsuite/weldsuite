
import { PageLoader } from '@/components/page-loader';
import { useActionTypes } from '@/hooks/queries/use-automation-queries';
import { ActionsClient } from './actions-client';
import { useI18n } from '@/lib/i18n/provider';

export default function ActionsPage() {
  const { t } = useI18n();
  const { data: actionTypesResult, isLoading } = useActionTypes();

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const actions = actionTypesResult?.data ?? [];

  // Derive categories from action types
  const categoryCounts = actions.reduce(
    (acc: Record<string, number>, action: any) => {
      acc[action.category] = (acc[action.category] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const ac = t.weldconnect.actions.actionCategories;
  const categories = [
    { id: 'communication', name: ac.communication, count: categoryCounts['communication'] || 0 },
    { id: 'data', name: ac.data, count: categoryCounts['data'] || 0 },
    { id: 'logic', name: ac.logic, count: categoryCounts['logic'] || 0 },
    { id: 'integration', name: ac.integration, count: categoryCounts['integration'] || 0 },
    { id: 'ai', name: ac.ai, count: categoryCounts['ai'] || 0 },
  ];

  return (
    <ActionsClient
      initialActions={actions}
      categories={categories}
    />
  );
}
