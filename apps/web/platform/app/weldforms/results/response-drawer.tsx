/**
 * One response in a side drawer: every answer (formatted against the version it
 * was given under), the files, hidden fields, the details, what each integration
 * did (with a retry for a failed one) and delete.
 */

import { useState, type ReactNode } from 'react';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { fieldsOf, isFileField } from '@weldsuite/forms-engine';
import type {
  FormDetail,
  FormResponseAction,
  FormResponseDetail,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import {
  saveBlob,
  useDeleteFormResponse,
  useFormResponse,
  useFormResponseFile,
  useRetryResponseAction,
  useVersionDefinitions,
} from '@/hooks/queries/use-weldforms-results-queries';
import { errorMessage } from './form-gate';
import { formatDuration } from './insights-tab';
import { answerText } from './response-cells';

const ACTION_TONE: Record<FormResponseAction['status'], SoftTone> = {
  pending: 'neutral',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

export function ResponseDrawer({
  form,
  responseId,
  onClose,
}: Readonly<{ form: FormDetail; responseId: string | null; onClose: () => void }>) {
  const { t, format } = useI18n();
  const td = t.weldformsResults.results.drawer;
  const query = useFormResponse(form.id, responseId);
  const response = query.data;

  return (
    <Sheet open={responseId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {response?.number != null ? format(td.title, { number: response.number }) : td.titleNoNumber}
          </SheetTitle>
          <SheetDescription className="sr-only">{td.title}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {query.isLoading ? (
            <PageLoader fullScreen={false} className="min-h-60" />
          ) : query.error || !response ? (
            <ErrorState message={td.loadFailed} onRetry={() => void query.refetch()} />
          ) : (
            <DrawerBody form={form} response={response} onDeleted={onClose} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  form,
  response,
  onDeleted,
}: Readonly<{ form: FormDetail; response: FormResponseDetail; onDeleted: () => void }>) {
  const { t, format, language } = useI18n();
  const tr = t.weldformsResults.results;
  const td = tr.drawer;
  const dash = t.weldformsResults.common.noValue;
  const definitions = useVersionDefinitions(form.id, [response.versionId]);
  const definition = definitions.get(response.versionId);
  const fields = definition ? fieldsOf(definition) : [];
  const dateTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteFormResponse(form.id);
  const retry = useRetryResponseAction(form.id);
  const download = useFormResponseFile(form.id);

  async function onRetry(actionId: string) {
    try {
      await retry.mutateAsync({ responseId: response.id, actionId });
      toast.success(td.retryQueued);
    } catch (err) {
      toast.error(errorMessage(err, td.retryFailed));
    }
  }

  async function onDownload(fileId: string, name: string) {
    try {
      const file = await download.mutateAsync({ responseId: response.id, fileId, fallbackName: name });
      saveBlob(file.blob, name || file.filename);
    } catch {
      toast.error(td.downloadFailed);
    }
  }

  async function onDelete() {
    try {
      await remove.mutateAsync(response.id);
      toast.success(td.deleteDone);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err, td.deleteFailed));
    } finally {
      setConfirmDelete(false);
    }
  }

  const partial = response.status === 'in_progress';
  const endingTitle = response.endingId ? definition?.endings.find((e) => e.id === response.endingId)?.title : undefined;
  const hiddenEntries = Object.entries(response.hidden);
  const variableEntries = Object.entries(response.variables);
  const meta = response.metadata;
  const respondent = response.respondentEmail ?? response.respondent?.name ?? response.respondent?.email ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <SoftBadge tone={partial ? 'warning' : 'success'}>{partial ? tr.responses.inProgress : tr.responses.completed}</SoftBadge>
        {response.abandoned && <SoftBadge tone="danger">{tr.responses.abandoned}</SoftBadge>}
        <SoftBadge tone="neutral">{format(tr.responses.version, { number: response.versionNumber })}</SoftBadge>
        {response.score !== null && (
          <SoftBadge tone="neutral">
            {td.score}: {response.score}
          </SoftBadge>
        )}
      </div>
      {partial && <p className="text-sm text-muted-foreground">{tr.responses.partialNote}</p>}

      <section aria-label={td.answers} className="space-y-4">
        <h3 className="text-sm font-semibold">{td.answers}</h3>
        {definition ? (
          fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tr.responses.noAnswers}</p>
          ) : (
            <dl className="space-y-4">
              {fields.map((field) => {
                const files = isFileField(field) ? response.files.filter((f) => f.blockId === field.id) : [];
                const text = isFileField(field) ? '' : answerText(field, response.answers[field.id]);
                return (
                  <div key={field.id} className="space-y-1">
                    <dt className="text-xs font-medium text-muted-foreground">{field.title}</dt>
                    <dd className="text-sm">
                      {files.length > 0 ? (
                        <ul className="space-y-1">
                          {files.map((file) => (
                            <li key={file.fileId} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5">
                              <span className="min-w-0 flex-1 truncate">
                                {file.kind === 'signature' ? td.signature : file.name}
                                <span className="ml-2 text-xs text-muted-foreground">{formatBytes(file.size, language)}</span>
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={download.isPending}
                                onClick={() => void onDownload(file.fileId, file.name)}
                              >
                                <Download className="mr-1.5 h-4 w-4" />
                                {td.download}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : text ? (
                        <span className="whitespace-pre-wrap break-words">{text}</span>
                      ) : (
                        <span className="text-muted-foreground">{td.unanswered}</span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )
        ) : (
          <PageLoader fullScreen={false} className="min-h-24" />
        )}
      </section>

      {hiddenEntries.length > 0 && (
        <Section title={td.hidden}>
          <Rows rows={hiddenEntries.map(([name, value]) => [name, value])} />
        </Section>
      )}

      {(variableEntries.length > 0 || endingTitle) && (
        <Section title={td.variables}>
          <Rows
            rows={[
              ...variableEntries.map(([name, value]): [string, ReactNode] => [name, String(value)]),
              ...(endingTitle ? ([[td.ending, endingTitle]] as Array<[string, ReactNode]>) : []),
            ]}
          />
        </Section>
      )}

      <Section title={td.respondent}>
        <Rows
          rows={[
            [td.respondent, respondent ?? (form.settings.hideMemberIdentity ? tr.responses.anonymous : dash)],
            ...(response.personId ? ([[td.person, response.personId]] as Array<[string, ReactNode]>) : []),
          ]}
        />
      </Section>

      <Section title={td.metadata}>
        <Rows
          rows={[
            [td.started, dateTime.format(new Date(response.startedAt))],
            [td.submitted, response.submittedAt ? dateTime.format(new Date(response.submittedAt)) : dash],
            [td.duration, formatDuration(response.durationMs, tr.insights.durationFormat, format) ?? dash],
            [td.source, meta.source ?? dash],
            [td.device, meta.device ?? dash],
            [td.browser, meta.browser ?? dash],
            [td.os, meta.os ?? dash],
            [td.country, meta.country ?? dash],
            [td.referrer, meta.referrer ?? dash],
            ...Object.entries(meta.utm ?? {}).map(([name, value]): [string, ReactNode] => [`${td.utm}: ${name}`, value]),
          ]}
        />
      </Section>

      <Section title={td.actions}>
        {response.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{td.noActions}</p>
        ) : (
          <ul className="space-y-2">
            {response.actions.map((action) => (
              <li key={action.id} className="space-y-1 rounded-md border p-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{td.actionKinds[action.kind]}</span>
                    <SoftBadge tone={ACTION_TONE[action.status]}>{td.actionStatus[action.status]}</SoftBadge>
                  </span>
                  {form.permissions.edit && action.status === 'failed' && (
                    <Button type="button" variant="outline" size="sm" disabled={retry.isPending} onClick={() => void onRetry(action.id)}>
                      <RefreshCw className="mr-1.5 h-4 w-4" />
                      {td.retry}
                    </Button>
                  )}
                </div>
                {action.entityType && action.entityId && (
                  <p className="text-xs text-muted-foreground">
                    {action.entityType} · {action.entityId}
                  </p>
                )}
                {action.error && <p className="break-words text-xs text-destructive">{action.error}</p>}
                {action.attempts > 1 && <p className="text-xs text-muted-foreground">{format(td.attempts, { count: action.attempts })}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {form.permissions.deleteResponses && (
        <div className="border-t pt-4">
          <Button type="button" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-1.5 h-4 w-4" />
            {td.delete}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={td.deleteTitle}
        description={td.deleteDescription}
        variant="destructive"
        confirmLabel={td.delete}
        cancelLabel={t.weldformsResults.common.cancel}
        loading={remove.isPending}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: Readonly<{ rows: Array<[string, ReactNode]> }>) {
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value], index) => (
        <div key={`${label}-${index}`} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}
