
import { AlertCircle, SearchX } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Link, useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import {
  isActiveExecutionStatus,
  useExecution,
  useExecutionLogs,
  useExecutionSteps,
  type ExecutionStep,
} from '@/hooks/queries/use-automation-queries';
import { ExecutionDetailClient, type ExecutionStepView } from './execution-detail-client';
import { extractExecutionError } from '../execution-utils';
import { useI18n } from '@/lib/i18n/provider';

export default function ExecutionDetailPage() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();

  const executionQuery = useExecution(id);
  const execution = executionQuery.data?.data;
  const isRunning = isActiveExecutionStatus(execution?.status);

  // Steps and logs are only worth fetching (and polling) once the run itself exists.
  const stepsQuery = useExecutionSteps(id, !!execution, isRunning);
  const logsQuery = useExecutionLogs(id, !!execution, isRunning);

  if (executionQuery.isLoading || (execution && (stepsQuery.isLoading || logsQuery.isLoading))) {
    return <PageLoader fullScreen={false} />;
  }

  if (!execution) {
    const notFound = !executionQuery.isError
      || (isApiError(executionQuery.error) && executionQuery.error.status === 404);
    return (
      <div className="container mx-auto max-w-[1200px] flex flex-col items-center gap-3 px-4 py-16 text-center">
        {notFound
          ? <SearchX className="h-10 w-10 text-muted-foreground" />
          : <AlertCircle className="h-10 w-10 text-destructive" />}
        <h1 className="text-lg font-semibold">
          {notFound ? t.weldconnect.executionDetail.notFoundTitle : t.weldconnect.executionDetail.loadErrorTitle}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {notFound
            ? t.weldconnect.executionDetail.notFoundDescription
            : t.weldconnect.executionDetail.loadErrorDescription}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {!notFound && (
            <Button variant="outline" size="sm" onClick={() => executionQuery.refetch()}>
              {t.weldconnect.executionDetail.tryAgain}
            </Button>
          )}
          <Link href="/weldconnect/executions">
            <Button size="sm">{t.weldconnect.executionDetail.backToExecutions}</Button>
          </Link>
        </div>
      </div>
    );
  }

  const steps = stepsQuery.data?.data ?? [];
  const logs = logsQuery.data?.data ?? [];

  // Transform execution data for the client component
  const executionWithSteps = {
    ...execution,
    // Map steps from the execution steps table
    steps: steps.map((step: ExecutionStep): ExecutionStepView => ({
      id: step.id,
      name: step.stepName,
      type: step.stepType,
      status: step.status === 'completed' ? 'success' : step.status,
      duration: step.duration ?? null,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      input: step.input,
      output: step.output,
      error: extractExecutionError(step.error),
    })),
    // Map triggerData to input for the Input Data tab
    input: execution.triggerData,
    error: extractExecutionError(execution.error),
  };

  return (
    <ExecutionDetailClient
      execution={executionWithSteps}
      initialLogs={logs}
    />
  );
}
