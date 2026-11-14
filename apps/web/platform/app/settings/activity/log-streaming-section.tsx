import { useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { EllipsisVertical, Pencil, Pause, Play, Plus, Radio, Send, Trash2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import {
  MAX_AUDIT_LOG_STREAMS,
  type AuditLogStream,
  type AuditLogStreamStatus,
  type AuditLogStreamTestResult,
} from '@weldsuite/core-api-client/schemas/audit-log-streams';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useAuditLogStreams,
  useDeleteAuditLogStream,
  useTestAuditLogStream,
  useUpdateAuditLogStream,
} from '@/hooks/queries/use-audit-log-stream-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LogStreamDialog } from './log-streaming-dialog';
import { destinationHost } from './log-streaming-form';

/** The platform switches a stream off after this many failed deliveries in a row (`audit-streams.ts`). */
const DISABLE_AFTER_FAILURES = 20;

const STATUS_TONE: Record<AuditLogStreamStatus, SoftTone> = {
  active: 'success',
  paused: 'warning',
  disabled: 'danger',
};

type TestOutcome = { kind: 'running' } | { kind: 'done'; result: AuditLogStreamTestResult } | { kind: 'failed' };

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return format(date, date.getFullYear() === new Date().getFullYear() ? 'MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
}

/**
 * Settings → Activity → Log streaming: the destinations the audit log is pushed
 * to. Needs `general:update` (the API refuses everything else, the list too,
 * because a collector URL can carry a secret), so other members see nothing.
 */
export function LogStreamingSection() {
  const canManage = useCan('general:update');
  if (!canManage) return null;
  return <LogStreamingContent />;
}

function LogStreamingContent() {
  const { t } = useI18n();
  const ts = t.settings.logStreaming;
  const { data: streams, isLoading, isError, refetch } = useAuditLogStreams();
  const update = useUpdateAuditLogStream();
  const remove = useDeleteAuditLogStream();
  const test = useTestAuditLogStream();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AuditLogStream | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AuditLogStream | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, TestOutcome>>({});

  const list = streams ?? [];
  const atLimit = list.length >= MAX_AUDIT_LOG_STREAMS;

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (stream: AuditLogStream) => {
    setEditing(stream);
    setDialogOpen(true);
  };

  const setStatus = async (stream: AuditLogStream, status: 'active' | 'paused', message: string) => {
    try {
      await update.mutateAsync({ id: stream.id, input: { status } });
      toast.success(message);
    } catch {
      toast.error(ts.messages.updateFailed);
    }
  };

  const sendTest = async (stream: AuditLogStream) => {
    setOutcomes((prev) => ({ ...prev, [stream.id]: { kind: 'running' } }));
    try {
      const result = await test.mutateAsync(stream.id);
      setOutcomes((prev) => ({ ...prev, [stream.id]: { kind: 'done', result } }));
    } catch {
      setOutcomes((prev) => ({ ...prev, [stream.id]: { kind: 'failed' } }));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast.success(ts.messages.deleted);
      setDeleteTarget(null);
    } catch {
      toast.error(ts.messages.deleteFailed);
    }
  };

  const describeOutcome = (outcome: TestOutcome | undefined) => {
    if (!outcome) return null;
    if (outcome.kind === 'running') return null;
    if (outcome.kind === 'failed') return { ok: false, text: ts.test.requestFailed };
    const { result } = outcome;
    if (result.ok) {
      const duration = String(result.durationMs);
      return {
        ok: true,
        text:
          result.status === null
            ? ts.test.successNoStatus.replace('{duration}', duration)
            : ts.test.success.replace('{status}', String(result.status)).replace('{duration}', duration),
      };
    }
    return {
      ok: false,
      text: result.error ? ts.test.failure.replace('{error}', result.error) : ts.test.failureUnknown,
    };
  };

  return (
    <SectionCard
      title={ts.title}
      description={ts.description}
      action={
        <Button size="sm" className="h-8" onClick={openCreate} disabled={atLimit} title={atLimit ? ts.limitReached.replace('{max}', String(MAX_AUDIT_LOG_STREAMS)) : undefined}>
          <Plus className="mr-0.5 h-4 w-4" />
          {ts.add}
        </Button>
      }
      contentClassName="space-y-4"
    >
      <InfoBanner variant="info" title={ts.delivery.title}>
        <ul className="list-disc space-y-1 pl-4">
          <li>{ts.delivery.start}</li>
          <li>{ts.delivery.order}</li>
          <li>{ts.delivery.retry.replace('{count}', String(DISABLE_AFTER_FAILURES))}</li>
          <li>{ts.delivery.resume}</li>
        </ul>
      </InfoBanner>

      {atLimit && <p className="text-sm text-muted-foreground">{ts.limitReached.replace('{max}', String(MAX_AUDIT_LOG_STREAMS))}</p>}

      {isLoading && <InlineSpinner />}
      {isError && <ErrorState message={ts.loadFailed} retryLabel={ts.retry} onRetry={() => void refetch()} />}
      {!isLoading && !isError && list.length === 0 && (
        <EmptyState
          icon={Radio}
          title={ts.empty.title}
          description={ts.empty.description}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-0.5 h-4 w-4" />
              {ts.add}
            </Button>
          }
        />
      )}
      {!isLoading && !isError && list.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[13.5px]">{ts.columns.name}</TableHead>
                <TableHead className="text-[13.5px]">{ts.columns.destination}</TableHead>
                <TableHead className="text-[13.5px]">{ts.columns.status}</TableHead>
                <TableHead className="text-right text-[13.5px]">{ts.columns.delivered}</TableHead>
                <TableHead className="text-[13.5px]">{ts.columns.lastDelivered}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((stream) => {
                const outcome = outcomes[stream.id];
                const described = describeOutcome(outcome);
                const lastDelivered = formatTime(stream.lastDeliveredAt);
                return (
                  <TableRow key={stream.id} className="group align-top">
                    <TableCell className="max-w-[320px]">
                      <div className="font-medium">{stream.name}</div>
                      <div className="text-xs text-muted-foreground">{ts.types[stream.type]}</div>
                      {stream.status === 'disabled' && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ts.disabledHint.replace('{count}', String(stream.consecutiveFailures || DISABLE_AFTER_FAILURES))}
                        </p>
                      )}
                      {stream.lastError && (
                        <p className="mt-1 break-words text-xs text-destructive">
                          {ts.lastError.replace('{error}', stream.lastError)}
                        </p>
                      )}
                      {outcome?.kind === 'running' && <InlineSpinner className="justify-start py-1" />}
                      {described && (
                        <p
                          role="status"
                          className={
                            described.ok
                              ? 'mt-1 text-xs text-emerald-700 dark:text-emerald-400'
                              : 'mt-1 break-words text-xs text-destructive'
                          }
                        >
                          {described.text}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="break-all rounded bg-muted px-2 py-1 text-xs">{destinationHost(stream.url)}</code>
                    </TableCell>
                    <TableCell>
                      <SoftBadge tone={STATUS_TONE[stream.status]}>{ts.status[stream.status]}</SoftBadge>
                    </TableCell>
                    <TableCell className="text-right text-[13.5px] tabular-nums">{stream.deliveredCount}</TableCell>
                    <TableCell className={lastDelivered ? 'text-[13.5px] tabular-nums' : 'text-[13.5px] text-muted-foreground'}>
                      {lastDelivered ?? ts.never}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6">
                            <span className="sr-only">{`${ts.actions.menu}: ${stream.name}`}</span>
                            <EllipsisVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(stream)}>
                            <Pencil className="mr-0.5 h-4 w-4" />
                            {ts.actions.edit}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void sendTest(stream)}>
                            <Send className="mr-0.5 h-4 w-4" />
                            {ts.actions.test}
                          </DropdownMenuItem>
                          {stream.status === 'active' && (
                            <DropdownMenuItem onClick={() => void setStatus(stream, 'paused', ts.messages.paused)}>
                              <Pause className="mr-0.5 h-4 w-4" />
                              {ts.actions.pause}
                            </DropdownMenuItem>
                          )}
                          {stream.status === 'paused' && (
                            <DropdownMenuItem onClick={() => void setStatus(stream, 'active', ts.messages.resumed)}>
                              <Play className="mr-0.5 h-4 w-4" />
                              {ts.actions.resume}
                            </DropdownMenuItem>
                          )}
                          {stream.status === 'disabled' && (
                            <DropdownMenuItem onClick={() => void setStatus(stream, 'active', ts.messages.switchedOn)}>
                              <Play className="mr-0.5 h-4 w-4" />
                              {ts.actions.switchOn}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setDeleteTarget(stream)}
                            className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                          >
                            <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                            {ts.actions.delete}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <LogStreamDialog open={dialogOpen} onOpenChange={setDialogOpen} stream={editing} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={ts.deleteDialog.title}
        description={ts.deleteDialog.description.replace('{name}', deleteTarget?.name ?? '')}
        confirmLabel={ts.deleteDialog.confirm}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </SectionCard>
  );
}
