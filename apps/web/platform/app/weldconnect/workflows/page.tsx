
import { PageLoader } from '@/components/page-loader';
import { useWorkflows, useWorkflowStats } from '@/hooks/queries/use-automation-queries';
import { useI18n } from '@/lib/i18n/provider';
import { WorkflowsClient } from './components/workflows-client';

export default function WorkflowsPage() {
  const { t } = useI18n();
  const { data: workflowsResult, isLoading: isWorkflowsLoading } = useWorkflows({ category: 'workflow' });
  const { data: statsResult, isLoading: isStatsLoading } = useWorkflowStats();

  if (isWorkflowsLoading || isStatsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const workflows = workflowsResult?.data ?? [];
  const stats = statsResult?.data;

  // Map workflows to client format
  const mappedWorkflows = workflows.map((w: any) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    status: w.status as 'active' | 'paused' | 'draft' | 'archived',
    triggerType: w.triggers?.[0]?.type,
    stepsCount: w.steps?.length || 0,
    executionCount: w.executionCount || 0,
    successRate: w.executionCount && w.successCount
      ? (w.successCount / w.executionCount) * 100
      : undefined,
    lastExecutedAt: w.lastExecutedAt,
    createdAt: w.createdAt,
  }));

  // Calculate stats
  const initialStats = {
    active: workflows.filter((w: any) => w.status === 'active').length,
    paused: workflows.filter((w: any) => w.status === 'paused').length,
    draft: workflows.filter((w: any) => w.status === 'draft').length,
    totalExecutions: stats?.totalExecutions || 0,
  };

  return (
    <WorkflowsClient
      initialWorkflows={mappedWorkflows}
      initialStats={initialStats}
      category="workflow"
      entityLabel={t.weldconnect.workflows.workflow}
      entityLabelPlural={t.weldconnect.workflows.title}
      parentLabel={t.weldconnect.breadcrumbs.task}
    />
  );
}
