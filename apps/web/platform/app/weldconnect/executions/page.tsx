
import { PageLoader } from '@/components/page-loader';
import { useExecutions, useWorkflows, type Workflow, type WorkflowExecution } from '@/hooks/queries/use-automation-queries';
import { ExecutionsClient } from './components/executions-client';
import { useI18n } from '@/lib/i18n/provider';

export default function ExecutionsPage() {
  const { t } = useI18n();
  const { data: executionsResult, isLoading: isExecutionsLoading } = useExecutions();
  const { data: workflowsResult, isLoading: isWorkflowsLoading } = useWorkflows();

  if (isExecutionsLoading || isWorkflowsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const executions = executionsResult?.data ?? [];
  const workflows = workflowsResult?.data ?? [];

  // Create workflow name lookup
  const workflowNames = new Map(workflows.map((w: Workflow) => [w.id, w.name]));

  // Map executions to client format
  const mappedExecutions = executions.map((e: WorkflowExecution) => ({
    id: e.id,
    workflowId: e.workflowId,
    workflowName: workflowNames.get(e.workflowId) || t.weldconnect.executionDetail.unknownWorkflow,
    status: (e.status === 'queued' ? 'pending' : e.status) as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
    triggerType: e.triggerType || 'manual',
    triggeredBy: e.triggeredBy ?? undefined,
    stepsCompleted: e.currentStepIndex || 0,
    stepsTotal: e.totalSteps || 0,
    duration: e.duration ?? undefined,
    startedAt: e.startedAt ? new Date(e.startedAt) : null,
    completedAt: e.completedAt ? new Date(e.completedAt) : null,
  }));

  return <ExecutionsClient initialExecutions={mappedExecutions} />;
}
