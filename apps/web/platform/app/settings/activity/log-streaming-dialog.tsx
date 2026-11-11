import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import {
  AUDIT_LOG_STREAM_FORMATS,
  AUDIT_LOG_STREAM_TYPES,
  MAX_AUDIT_LOG_STREAMS,
  type AuditLogStream,
} from '@weldsuite/core-api-client/schemas/audit-log-streams';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useCreateAuditLogStream, useUpdateAuditLogStream } from '@/hooks/queries/use-audit-log-stream-queries';
import { useI18n } from '@/lib/i18n/provider';
import {
  EMPTY_STREAM_FORM,
  buildStreamFormSchema,
  toCreateInput,
  toUpdateInput,
  valuesFromStream,
  type StreamFormValues,
  type TokenAction,
} from './log-streaming-form';

interface LogStreamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The stream being edited; `null` creates one. */
  stream: AuditLogStream | null;
}

/** `error.details` of an API error response, when it has any. */
function errorDetails(err: unknown): Record<string, unknown> | null {
  if (!isApiError(err)) return null;
  const body = err.body as { error?: { details?: unknown } } | undefined;
  const details = body?.error?.details;
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : null;
}

export function LogStreamDialog({ open, onOpenChange, stream }: Readonly<LogStreamDialogProps>) {
  const { t } = useI18n();
  const ts = t.settings.logStreaming;
  const tf = ts.form;
  const create = useCreateAuditLogStream();
  const update = useUpdateAuditLogStream();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tokenAction, setTokenAction] = useState<TokenAction>('replace');

  const schema = useMemo(
    () =>
      buildStreamFormSchema({
        nameRequired: tf.nameRequired,
        urlRequired: tf.urlRequired,
        authHeaderInvalid: tf.authHeaderInvalid,
      }),
    [tf.nameRequired, tf.urlRequired, tf.authHeaderInvalid],
  );
  const form = useForm<StreamFormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY_STREAM_FORM });

  const editing = stream !== null;
  const hasSavedToken = stream?.hasToken === true;

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    // A saved token is kept unless the member replaces or removes it.
    setTokenAction(hasSavedToken ? 'keep' : 'replace');
    form.reset(stream ? valuesFromStream(stream) : EMPTY_STREAM_FORM);
  }, [open, stream, hasSavedToken, form]);

  const type = form.watch('type');
  const isSplunk = type === 'splunk_hec';
  const pending = create.isPending || update.isPending;
  const submitLabels = editing ? { idle: tf.save, busy: tf.saving } : { idle: tf.create, busy: tf.creating };
  const submitLabel = pending ? submitLabels.busy : submitLabels.idle;

  async function onSubmit(values: StreamFormValues) {
    form.clearErrors();
    setSubmitError(null);
    try {
      if (stream) {
        await update.mutateAsync({ id: stream.id, input: toUpdateInput(values, tokenAction) });
        toast.success(ts.messages.updated);
      } else {
        await create.mutateAsync(toCreateInput(values));
        toast.success(ts.messages.created);
      }
      onOpenChange(false);
    } catch (err) {
      const details = errorDetails(err);
      if (isApiError(err) && err.status === 400 && details?.field === 'url') {
        form.setError('url', { message: err.message });
      } else if (isApiError(err) && err.status === 409) {
        setSubmitError(ts.messages.limit.replace('{max}', String(details?.limit ?? MAX_AUDIT_LOG_STREAMS)));
      } else {
        setSubmitError(stream ? ts.messages.updateFailed : ts.messages.createFailed);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? tf.editTitle : tf.createTitle}</DialogTitle>
          <DialogDescription>{tf.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <ErrorBanner error={submitError} onDismiss={() => setSubmitError(null)} />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.name}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tf.namePlaceholder} autoFocus />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.type}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {AUDIT_LOG_STREAM_TYPES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {ts.types[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.url}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      placeholder={isSplunk ? tf.urlPlaceholderSplunk : tf.urlPlaceholderHttp}
                    />
                  </FormControl>
                  <FormDescription>{isSplunk ? tf.urlHelpSplunk : tf.urlHelpHttp}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {tf.token} <span className="font-normal text-muted-foreground">({tf.tokenOptional})</span>
                  </FormLabel>
                  {hasSavedToken && tokenAction !== 'replace' ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                      <p className="text-sm text-muted-foreground">
                        {tokenAction === 'remove' ? tf.tokenWillRemove : tf.tokenSaved}
                      </p>
                      <div className="flex gap-2">
                        {tokenAction === 'remove' ? (
                          <Button type="button" variant="outline" size="sm" onClick={() => setTokenAction('keep')}>
                            {tf.tokenUndo}
                          </Button>
                        ) : (
                          <>
                            <Button type="button" variant="outline" size="sm" onClick={() => setTokenAction('replace')}>
                              {tf.tokenReplace}
                            </Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => setTokenAction('remove')}>
                              {tf.tokenRemove}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <FormControl>
                        <Input
                          {...field}
                          type="password"
                          autoComplete="new-password"
                          placeholder={hasSavedToken ? tf.tokenNew : undefined}
                        />
                      </FormControl>
                      {hasSavedToken && (
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              field.onChange('');
                              setTokenAction('keep');
                            }}
                          >
                            {tf.tokenUndo}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                  <FormDescription>{isSplunk ? tf.tokenHelpSplunk : tf.tokenHelpHttp}</FormDescription>
                </FormItem>
              )}
            />

            {isSplunk ? (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">{tf.splunkSettings}</legend>
                <p className="text-sm text-muted-foreground">{tf.splunkOptionalHelp}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['index', 'source', 'sourcetype', 'host'] as const).map((name) => (
                    <FormField
                      key={name}
                      control={form.control}
                      name={name}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tf[name]}</FormLabel>
                          <FormControl>
                            <Input {...field} autoComplete="off" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              </fieldset>
            ) : (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">{tf.httpSettings}</legend>
                <FormField
                  control={form.control}
                  name="authHeader"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.authHeader}</FormLabel>
                      <FormControl>
                        <Input {...field} autoComplete="off" placeholder={tf.authHeaderPlaceholder} />
                      </FormControl>
                      <FormDescription>{tf.authHeaderHelp}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="format"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.format}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {AUDIT_LOG_STREAM_FORMATS.map((value) => (
                            <SelectItem key={value} value={value}>
                              {tf.formats[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                {tf.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
