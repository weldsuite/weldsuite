
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useExecution, useExecutionLogs, useExecutionSteps } from '@/hooks/queries/use-automation-queries';
import { ExecutionDetailClient, type ExecutionStepView } from './execution-detail-client';
import { useI18n } from '@/lib/i18n/provider';
import type { ExecutionStep } from '@weldsuite/core-api-client/schemas/weldconnect';

export default function ExecutionDetailPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();

  const { data: executionResult, isLoading: isExecutionLoading } = useExecution(id);
  const { data: stepsResult, isLoading: isStepsLoading } = useExecutionSteps(id);
  const { data: logsResult, isLoading: isLogsLoading } = useExecutionLogs(id);

  const execution = executionResult?.data;

  if (isExecutionLoading || isStepsLoading || isLogsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!execution) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">{t.weldconnect.executions.noResults}</p>
      </div>
    );
  }

  const steps = stepsResult?.data ?? [];
  const logs = logsResult?.data ?? [];

  // Transform execution data for the client component
  const executionWithSteps = {
    ...execution,
    // Map steps from the execution steps table
    steps: steps.map((step: ExecutionStep): ExecutionStepView => ({
      id: step.id,
      name: step.stepName,
      type: step.stepType,
      status: step.status === 'completed' ? 'success' : step.status,
      duration: step.duration ?? 0,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      input: step.input,
      output: step.output,
      error: step.error?.message || (typeof step.error === 'string' ? step.error : null),
    })),
    // Map triggerData to input for the Input Data tab
    input: execution.triggerData,
    // Extract error message if error is an object
    error: execution.error?.message || (typeof execution.error === 'string' ? execution.error : null),
  };

  return (
    <ExecutionDetailClient
      execution={executionWithSteps}
      initialLogs={logs}
    />
  );
}
