/**
 * "Add to CRM": creates (or links) the CRM person for this prospect and, if
 * asked, an opportunity in a pipeline stage.
 */

import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  reachAddToCrmSchema,
  type ReachAddToCrmInput,
} from '@weldsuite/app-api-client/schemas/reach';
import { useAddReachThreadToCrm } from '@/hooks/queries/use-reach-inbox-queries';
import { usePipelines, usePipelineStages } from '@/hooks/queries/use-pipelines-queries';
import { ErrorBanner, errorMessage } from '@/app/weldreach/components/engage/kit';

export function AddToCrmDialog({
  threadKey,
  prospectLabel,
  onClose,
}: Readonly<{ threadKey: string; prospectLabel: string; onClose: () => void }>) {
  const t = useTranslations();
  const addToCrm = useAddReachThreadToCrm(threadKey);
  const pipelines = usePipelines();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<ReachAddToCrmInput>({
    resolver: zodResolver(reachAddToCrmSchema),
    defaultValues: { opportunity: undefined },
  });
  const opportunity = form.watch('opportunity');
  const withOpportunity = opportunity !== undefined;
  const pipelineId = opportunity?.pipelineId ?? '';

  const stages = usePipelineStages(pipelineId || undefined);
  const pipelineOptions = useMemo(
    () => (pipelines.data?.data ?? []).filter((pipeline) => !pipeline.isArchived),
    [pipelines.data],
  );
  const stageOptions = useMemo(
    () =>
      (stages.data?.data ?? [])
        .filter((stage) => stage.pipeline === pipelineId)
        .sort((a, b) => a.position - b.position),
    [stages.data, pipelineId],
  );

  // Start a new opportunity on the default pipeline's first open stage.
  function enableOpportunity(enabled: boolean) {
    if (!enabled) {
      form.setValue('opportunity', undefined, { shouldDirty: true });
      return;
    }
    const preferred = pipelineOptions.find((pipeline) => pipeline.isDefault) ?? pipelineOptions[0];
    form.setValue(
      'opportunity',
      { pipelineId: preferred?.id ?? '', stageId: '' },
      { shouldDirty: true },
    );
  }

  // Once the stages of the chosen pipeline are known, pick the first open one.
  useEffect(() => {
    if (!withOpportunity || stageOptions.length === 0) return;
    if (stageOptions.some((stage) => stage.id === form.getValues('opportunity.stageId'))) return;
    const first = stageOptions.find((stage) => !stage.isWon && !stage.isLost) ?? stageOptions[0];
    if (first) form.setValue('opportunity.stageId', first.id);
  }, [withOpportunity, stageOptions, form]);

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      const name = values.opportunity?.name?.trim();
      await addToCrm.mutateAsync({
        opportunity: values.opportunity
          ? {
              pipelineId: values.opportunity.pipelineId,
              stageId: values.opportunity.stageId,
              name: name ? name : undefined,
            }
          : undefined,
      });
      toast.success(
        values.opportunity
          ? t('reachEngage.inbox.crm.addedWithOpportunity')
          : t('reachEngage.inbox.crm.added'),
      );
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.inbox.crm.failed')));
    }
  });

  const errors = form.formState.errors.opportunity;

  return (
    <Dialog open onOpenChange={(open) => !open && !addToCrm.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('reachEngage.inbox.crm.title')}</DialogTitle>
          <DialogDescription>
            {t('reachEngage.inbox.crm.description', { prospect: prospectLabel })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2">
            <div className="space-y-0.5">
              <Label htmlFor="reach-crm-opportunity" className="text-sm">
                {t('reachEngage.inbox.crm.createOpportunity')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('reachEngage.inbox.crm.createOpportunityHint')}</p>
            </div>
            <Switch
              id="reach-crm-opportunity"
              checked={withOpportunity}
              onCheckedChange={enableOpportunity}
              disabled={pipelines.isLoading || addToCrm.isPending}
            />
          </div>

          {withOpportunity && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label id="reach-crm-pipeline-label">{t('reachEngage.inbox.crm.pipeline')}</Label>
                <Controller
                  control={form.control}
                  name="opportunity.pipelineId"
                  render={({ field }) => (
                    <Select
                      value={field.value ?? ''}
                      onValueChange={(value) => {
                        field.onChange(value);
                        form.setValue('opportunity.stageId', '');
                      }}
                    >
                      <SelectTrigger aria-labelledby="reach-crm-pipeline-label" className="w-full">
                        <SelectValue placeholder={t('reachEngage.inbox.crm.pipelinePlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {pipelineOptions.map((pipeline) => (
                          <SelectItem key={pipeline.id} value={pipeline.id}>
                            {pipeline.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors?.pipelineId && (
                  <p className="text-xs text-destructive">{t('reachEngage.inbox.crm.pipelineRequired')}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label id="reach-crm-stage-label">{t('reachEngage.inbox.crm.stage')}</Label>
                <Controller
                  control={form.control}
                  name="opportunity.stageId"
                  render={({ field }) => (
                    <Select
                      value={field.value ?? ''}
                      onValueChange={field.onChange}
                      disabled={!pipelineId}
                    >
                      <SelectTrigger aria-labelledby="reach-crm-stage-label" className="w-full">
                        <SelectValue placeholder={t('reachEngage.inbox.crm.stagePlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {stageOptions.map((stage) => (
                          <SelectItem key={stage.id} value={stage.id}>
                            {stage.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors?.stageId && (
                  <p className="text-xs text-destructive">{t('reachEngage.inbox.crm.stageRequired')}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="reach-crm-opportunity-name">{t('reachEngage.inbox.crm.opportunityName')}</Label>
                <Input
                  id="reach-crm-opportunity-name"
                  autoComplete="off"
                  placeholder={t('reachEngage.inbox.crm.opportunityNamePlaceholder')}
                  {...form.register('opportunity.name', {
                    // An empty name means "let the CRM pick one"; the schema needs it absent, not empty.
                    setValueAs: (value: string) => (value.trim() === '' ? undefined : value),
                  })}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={addToCrm.isPending}>
              {t('reachEngage.common.cancel')}
            </Button>
            <Button type="submit" disabled={addToCrm.isPending}>
              {addToCrm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('reachEngage.inbox.crm.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
