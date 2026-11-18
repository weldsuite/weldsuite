/**
 * Create or edit a raw export: the storage (provider preset, endpoint,
 * region, bucket, folder, keys), the tables, how often and from when. The
 * secret key is write-only: required for a new export, left empty to keep
 * the stored one. "Test connection" writes and deletes a test file.
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  PANEL_EXPORT_FREQUENCIES,
  PANEL_EXPORT_PROVIDERS,
  PANEL_EXPORT_TABLES,
  type PanelExportDto,
  type PanelExportFrequency,
  type PanelExportProvider,
  type PanelExportTable,
  type PanelExportTestDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useCreateWeldPanelExport, useTestWeldPanelExport, useUpdateWeldPanelExport } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { fromLocalInput, toLocalDateInput } from '../lib/date-input';
import { EXPORT_PROVIDER_PRESETS, isExportEndpoint } from '../lib/export-providers';

interface ExportFormValues {
  name: string;
  provider: PanelExportProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  tables: PanelExportTable[];
  frequency: PanelExportFrequency;
  startAt: string;
}

function initialValues(existing: PanelExportDto | null | undefined): ExportFormValues {
  const provider = existing?.destination.provider ?? 's3';
  const preset = EXPORT_PROVIDER_PRESETS[provider];
  return {
    name: existing?.name ?? '',
    provider,
    endpoint: existing?.destination.endpoint ?? '',
    region: existing?.destination.region ?? preset.defaultRegion,
    bucket: existing?.destination.bucket ?? '',
    prefix: existing?.destination.prefix ?? 'weldpanel',
    accessKeyId: existing?.destination.accessKeyId ?? '',
    secretAccessKey: '',
    pathStyle: existing?.destination.pathStyle ?? preset.pathStyle,
    tables: existing?.tables ?? ['events'],
    frequency: existing?.frequency ?? 'daily',
    startAt: toLocalDateInput(existing?.startAt ?? new Date().toISOString()),
  };
}

function destinationOf(values: ExportFormValues) {
  const preset = EXPORT_PROVIDER_PRESETS[values.provider];
  return {
    provider: values.provider,
    endpoint: preset.needsEndpoint ? values.endpoint.trim() : null,
    region: values.region.trim(),
    bucket: values.bucket.trim(),
    prefix: values.prefix.trim(),
    accessKeyId: values.accessKeyId.trim(),
    pathStyle: values.pathStyle,
  };
}

interface ExportFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  existing?: PanelExportDto | null;
}

export function ExportFormDialog({ open, onOpenChange, projectId, existing }: Readonly<ExportFormDialogProps>) {
  const { t, format } = useI18n();
  const te = t.weldpanel.collab.exports;
  const tf = te.form;
  const tc = t.weldpanel.analytics.common;
  const create = useCreateWeldPanelExport();
  const update = useUpdateWeldPanelExport();
  const test = useTestWeldPanelExport();
  const [testResult, setTestResult] = useState<PanelExportTestDto | null>(null);

  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, tf.required).max(255),
          provider: z.enum(PANEL_EXPORT_PROVIDERS),
          endpoint: z.string(),
          region: z.string().trim().min(1, tf.required),
          bucket: z.string().trim().min(3, tf.required),
          prefix: z.string().max(200),
          accessKeyId: z.string().trim().min(1, tf.required).max(128),
          secretAccessKey: z.string().max(256),
          pathStyle: z.boolean(),
          tables: z.array(z.enum(PANEL_EXPORT_TABLES)).min(1, tf.tablesRequired),
          frequency: z.enum(PANEL_EXPORT_FREQUENCIES),
          startAt: z.string(),
        })
        .superRefine((v, ctx) => {
          if (EXPORT_PROVIDER_PRESETS[v.provider].needsEndpoint && !isExportEndpoint(v.endpoint)) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: tf.endpointInvalid });
          if (!existing && v.secretAccessKey.trim() === '') ctx.addIssue({ code: 'custom', path: ['secretAccessKey'], message: tf.required });
        }),
    [tf.required, tf.tablesRequired, tf.endpointInvalid, existing],
  );
  const form = useForm<ExportFormValues>({ resolver: zodResolver(schema), defaultValues: initialValues(existing) });
  const values = useWatch({ control: form.control }) as ExportFormValues;
  const preset = EXPORT_PROVIDER_PRESETS[values.provider ?? 's3'];

  useEffect(() => {
    if (!open) return;
    form.reset(initialValues(existing));
    setTestResult(null);
  }, [open, existing, form]);

  async function runTest() {
    const ok = await form.trigger(['provider', 'endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', ...(existing ? [] : (['secretAccessKey'] as const))]);
    if (!ok) return;
    const v = form.getValues();
    const secret = v.secretAccessKey.trim();
    setTestResult(null);
    try {
      const result = await test.mutateAsync(
        existing
          ? { exportId: existing.id, destination: destinationOf(v), ...(secret ? { secretAccessKey: secret } : {}) }
          : { projectId, destination: destinationOf(v), secretAccessKey: secret },
      );
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, wrote: false, deleted: false, error: null });
    }
  }

  const submitting = form.formState.isSubmitting;
  const submit = form.handleSubmit(async (v) => {
    const secret = v.secretAccessKey.trim();
    try {
      if (existing) {
        await update.mutateAsync({
          id: existing.id,
          name: v.name.trim(),
          destination: destinationOf(v),
          ...(secret ? { secretAccessKey: secret } : {}),
          tables: v.tables,
          frequency: v.frequency,
        });
        toast.success(tf.saved);
      } else {
        const startAt = fromLocalInput(v.startAt);
        await create.mutateAsync({
          projectId,
          name: v.name.trim(),
          destination: destinationOf(v),
          secretAccessKey: secret,
          tables: v.tables,
          frequency: v.frequency,
          ...(startAt ? { startAt } : {}),
        });
        toast.success(tf.created);
      }
      onOpenChange(false);
    } catch {
      toast.error(tf.failed);
    }
  });

  let testBanner: React.ReactNode = null;
  if (testResult) {
    if (testResult.ok && testResult.deleted) testBanner = <InfoBanner variant="success">{te.test.ok}</InfoBanner>;
    else if (testResult.ok || testResult.wrote) testBanner = <InfoBanner variant="warning">{te.test.okNotDeleted}</InfoBanner>;
    else testBanner = <InfoBanner variant="danger">{testResult.error ? format(te.test.failed, { error: testResult.error }) : te.test.failedUnknown}</InfoBanner>;
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? tf.editTitle : tf.createTitle}</DialogTitle>
          <DialogDescription>{te.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} noValidate className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.nameLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={tf.namePlaceholder} maxLength={255} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.providerLabel}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(next) => {
                        const provider = next as PanelExportProvider;
                        field.onChange(provider);
                        form.setValue('region', EXPORT_PROVIDER_PRESETS[provider].defaultRegion);
                        form.setValue('pathStyle', EXPORT_PROVIDER_PRESETS[provider].pathStyle);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PANEL_EXPORT_PROVIDERS.map((provider) => (
                          <SelectItem key={provider} value={provider}>
                            {te.providers[provider]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>{te.providerHints[field.value]}</FormDescription>
                  </FormItem>
                )}
              />
            </div>

            {preset.needsEndpoint && (
              <FormField
                control={form.control}
                name="endpoint"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.endpointLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} type="url" placeholder={preset.endpointPlaceholder} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.regionLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={preset.regionPlaceholder} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="bucket"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.bucketLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="prefix"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.prefixLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">{tf.prefixHint}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="accessKeyId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.accessKeyLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" spellCheck={false} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="secretAccessKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.secretKeyLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} type="password" autoComplete="new-password" spellCheck={false} />
                    </FormControl>
                    <FormDescription>{existing ? tf.secretKeyKeep : tf.secretKeyHint}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="pathStyle"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <Label htmlFor="weldpanel-export-path-style">{tf.pathStyleLabel}</Label>
                    <p className="text-xs text-muted-foreground">{tf.pathStyleHint}</p>
                  </div>
                  <FormControl>
                    <Switch id="weldpanel-export-path-style" checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => void runTest()}>
                {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
                {test.isPending ? tf.testing : tf.test}
              </Button>
            </div>
            {testBanner}

            <FormField
              control={form.control}
              name="tables"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tf.tablesLabel}</FormLabel>
                  <div className="flex flex-wrap gap-4">
                    {PANEL_EXPORT_TABLES.map((table) => (
                      <div key={table} className="flex items-center gap-2">
                        <Checkbox
                          id={`weldpanel-export-table-${table}`}
                          checked={field.value.includes(table)}
                          onCheckedChange={(checked) => field.onChange(checked === true ? [...field.value, table] : field.value.filter((t2) => t2 !== table))}
                        />
                        <Label htmlFor={`weldpanel-export-table-${table}`} className="font-normal">
                          {te.tables[table]}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="frequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tf.frequencyLabel}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PANEL_EXPORT_FREQUENCIES.map((frequency) => (
                          <SelectItem key={frequency} value={frequency}>
                            {tf.frequencies[frequency]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              {!existing && (
                <FormField
                  control={form.control}
                  name="startAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tf.startLabel}</FormLabel>
                      <FormControl>
                        <Input {...field} type="date" />
                      </FormControl>
                      <FormDescription>{tf.startHint}</FormDescription>
                    </FormItem>
                  )}
                />
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                {tc.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                {existing ? tf.save : tf.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
