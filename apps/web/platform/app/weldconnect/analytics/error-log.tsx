import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCheck, CheckCircle2, ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  useAcknowledgeWorkflowError,
  useAcknowledgeWorkflowErrors,
  useWorkflowErrors,
  type WorkflowErrorStatus,
} from '@/hooks/queries/use-workflow-error-queries';
import { errorLogPageCount } from './analytics-utils';

const PAGE_SIZE = 20;

/**
 * The error log: failed steps of live runs, newest first, with acknowledge
 * (one row or everything still open). Acknowledged rows stay in the "All" view.
 */
export function ErrorLog() {
  const { t } = useI18n();
  const el = t.weldconnect.analytics.errorLog;
  const [status, setStatus] = useState<WorkflowErrorStatus>('unacknowledged');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useWorkflowErrors({ status, page, limit: PAGE_SIZE });
  const acknowledgeOne = useAcknowledgeWorkflowError();
  const acknowledgeAll = useAcknowledgeWorkflowErrors();

  const items = data?.items ?? [];
  const pages = errorLogPageCount(data?.total ?? 0, PAGE_SIZE);
  const severityLabels = el.severity as Record<string, string>;

  const changeStatus = (next: string) => {
    setStatus(next === 'all' ? 'all' : 'unacknowledged');
    setPage(1);
  };

  const handleAcknowledge = (id: string) => {
    acknowledgeOne.mutate(id, {
      onSuccess: () => toast.success(el.toasts.acknowledged),
      onError: () => toast.error(el.toasts.failed),
    });
  };

  const handleAcknowledgeAll = () => {
    acknowledgeAll.mutate(
      { all: true },
      {
        onSuccess: (result) => {
          toast.success(el.toasts.acknowledgedMany.replace('{count}', String(result.acknowledged)));
          setPage(1);
        },
        onError: () => toast.error(el.toasts.failed),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between space-y-0">
        <div>
          <CardTitle>{el.title}</CardTitle>
          <CardDescription>{el.description}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={status === 'all' ? 'all' : 'open'} onValueChange={changeStatus}>
            <TabsList>
              <TabsTrigger value="open">
                {el.filterOpen}
                {data && data.unacknowledged > 0 ? ` (${data.unacknowledged})` : ''}
              </TabsTrigger>
              <TabsTrigger value="all">{el.filterAll}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAcknowledgeAll}
            disabled={!data || data.unacknowledged === 0 || acknowledgeAll.isPending}
          >
            <CheckCheck className="h-4 w-4 mr-0.5" />
            {el.acknowledgeAll}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!isLoading && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <CheckCircle2 className="h-12 w-12 text-green-500/30 mb-4" />
            <p className="text-sm text-muted-foreground">{el.empty}</p>
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-4 py-3">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium truncate">{item.workflowName ?? el.deletedWorkflow}</span>
                    <Badge variant={item.severity === 'warning' ? 'outline' : 'destructive'} className="text-[11px]">
                      {severityLabels[item.severity] ?? item.severity}
                    </Badge>
                    {item.errorType && (
                      <Badge variant="secondary" className="text-[11px] font-mono">{item.errorType}</Badge>
                    )}
                  </div>
                  <p className="text-sm text-red-700 dark:text-red-300 break-words">{item.errorMessage}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(item.occurredAt).toLocaleString()}
                    {item.stepName || item.stepType ? ` · ${el.step.replace('{step}', item.stepName ?? item.stepType ?? '')}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.executionId && (
                    <Link href={`/weldconnect/executions/${item.executionId}`}>
                      <Button variant="ghost" size="sm">
                        <ExternalLink className="h-4 w-4 mr-0.5" />
                        {el.viewRun}
                      </Button>
                    </Link>
                  )}
                  {item.acknowledgedAt ? (
                    <Badge variant="outline" className="text-[11px]">
                      <CheckCircle2 className="h-3 w-3 mr-1 text-green-600" />
                      {el.acknowledged}
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleAcknowledge(item.id)}
                      disabled={acknowledgeOne.isPending}
                    >
                      {el.acknowledge}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between pt-4">
            <span className="text-xs text-muted-foreground">
              {el.pageOf.replace('{page}', String(page)).replace('{pages}', String(pages))}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                {el.previous}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
                {el.next}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
