
import { PageLoader } from '@/components/page-loader';
import { useWorkflows, useWorkflowStats, type Workflow } from '@/hooks/queries/use-automation-queries';
import { useI18n } from '@/lib/i18n/provider';
import { WorkflowsClient } from './components/workflows-client';

function firstTriggerType(triggers: unknown[]): string | undefined {
  const first = triggers[0] as { type?: string } | undefined;
  return first?.type;
}

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
  const mappedWorkflows = workflows.map((w: Workflow) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    status: w.status as 'active' | 'paused' | 'draft' | 'archived',
    triggerType: firstTriggerType(w.triggers),
    stepsCount: w.steps?.length || 0,
    executionCount: w.executionCount || 0,
    successRate: w.executionCount && w.successCount
      ? (w.successCount / w.executionCount) * 100
      : undefined,
    lastExecutedAt: w.lastExecutedAt ? new Date(w.lastExecutedAt) : null,
    createdAt: new Date(w.createdAt),
    updatedAt: w.updatedAt ? new Date(w.updatedAt) : null,
  }));

  // Calculate stats
  const initialStats = {
    active: workflows.filter((w: Workflow) => w.status === 'active').length,
    paused: workflows.filter((w: Workflow) => w.status === 'paused').length,
    draft: workflows.filter((w: Workflow) => w.status === 'draft').length,
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
