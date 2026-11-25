import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  DELIVERY_APPROACHES,
  DEFINITION_OF_DONE_ITEM_MAX,
  DEFINITION_OF_DONE_MAX_ITEMS,
  WIP_LIMIT_MAX,
  type DeliveryApproach,
  type DeliverySettings,
} from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SettingRow, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { apiMessage } from '../close/_lib/api-error';
import { APPROACH_DEFAULTS } from '@/app/weldflow/lib/delivery';
import { stagesApi } from '@/app/weldflow/lib/api-client';
import { useProjectTabDefs } from '@/app/weldflow/hooks/use-project-tabs';
import { agileKeys, useProjectDelivery, useUpdateProjectDelivery } from '@/hooks/queries/use-flow-agile-queries';
import { useProjectTabSettings, useUpdateProjectTabSettings } from '@/hooks/queries/use-project-tab-settings';

/** Sprint lengths offered, in days: one to four weeks. */
const SPRINT_LENGTHS = [7, 14, 21, 28] as const;

interface DeliverySectionProps {
  projectId: string;
  /** A project manager or admin: the only ones who may change it. */
  isAdmin: boolean;
}

/** The lines of "What this changes in the project" for one approach. */
function useChanges(approach: DeliveryApproach): string[] {
  const { t } = useI18n();
  const copy = t.flowAgile.delivery.changes;
  if (approach === 'tasklist') return [copy.nothing];
  const d = APPROACH_DEFAULTS[approach];
  const lines = [d.tasksOpensOn === 'backlog' ? copy.tasksOpensOnBacklog : copy.tasksOpensOnList];
  if (d.usesSprints) lines.push(copy.pipelineShowsSprint);
  else if (d.usesWipLimits) lines.push(copy.pipelineShowsWip);
  else lines.push(copy.pipelineShowsAll);
  lines.push(d.usesItemTypes ? copy.itemTypesOn : copy.itemTypesOff);
  if (d.usesSprints) lines.push(copy.sprintsOn);
  if (d.usesPhases) lines.push(d.usesSprints ? copy.phasesWithSprints : copy.phasesOn);
  return lines;
}

export function DeliverySection({ projectId, isAdmin }: Readonly<DeliverySectionProps>) {
  const { t, plural } = useI18n();
  const copy = t.flowAgile.delivery;
  const headingId = useId();
  const delivery = useProjectDelivery(projectId);
  const save = useUpdateProjectDelivery(projectId);
  const tabSettings = useProjectTabSettings(projectId);
  const saveTabs = useUpdateProjectTabSettings(projectId);
  const tabDefs = useProjectTabDefs();
  const stages = useQuery({
    queryKey: [...agileKeys.root(projectId), 'stages'],
    queryFn: async () => {
      const res = await stagesApi.list(projectId);
      return res.success && res.data ? res.data : [];
    },
    enabled: !!projectId,
  });

  // The form edits a copy; `null` while it matches what is saved.
  const [draft, setDraft] = useState<DeliverySettings | null>(null);
  const [showSuggestedTabs, setShowSuggestedTabs] = useState(true);
  const [newCriterion, setNewCriterion] = useState('');
  const current = draft ?? delivery.settings;
  const defaults = APPROACH_DEFAULTS[current.approach];
  const changes = useChanges(current.approach);
  const approachChanged = current.approach !== delivery.settings.approach;
  const offerSuggestedTabs = approachChanged && defaults.suggestedTabs.length > 0;
  const disabled = !isAdmin || save.isPending;

  if (delivery.isLoading) return <PageLoader fullScreen={false} />;

  const edit = (next: Partial<DeliverySettings>) => setDraft({ ...current, ...next });

  const setWipLimit = (stageId: string, limit: number | undefined) => {
    const wipLimits = { ...current.wipLimits };
    if (limit && limit > 0) wipLimits[stageId] = Math.min(limit, WIP_LIMIT_MAX);
    else delete wipLimits[stageId];
    edit({ wipLimits });
  };

  const addCriterion = () => {
    const text = newCriterion.trim();
    if (!text || current.definitionOfDone.length >= DEFINITION_OF_DONE_MAX_ITEMS) return;
    edit({ definitionOfDone: [...current.definitionOfDone, text] });
    setNewCriterion('');
  };

  const removeCriterion = (index: number) =>
    edit({ definitionOfDone: current.definitionOfDone.filter((_, i) => i !== index) });

  // The suggested tabs show; every other tab is hidden for the project.
  const applySuggestedTabs = (approach: DeliveryApproach) => {
    const keep = new Set<string>([...APPROACH_DEFAULTS[approach].suggestedTabs, 'settings']);
    const hidden = tabDefs.map((tab) => tab.id).filter((id) => !keep.has(id));
    saveTabs.mutate(
      { ...tabSettings.settings, hidden },
      { onError: (error) => toast.error(apiMessage(error, t.flowAgile.shared.saveFailed)) },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || disabled) return;
    const approach = draft.approach;
    const applyTabs = offerSuggestedTabs && showSuggestedTabs;
    save.mutate(draft, {
      onSuccess: () => {
        setDraft(null);
        if (applyTabs) applySuggestedTabs(approach);
        toast.success(t.flowAgile.shared.saved);
      },
      onError: (error) => toast.error(apiMessage(error, t.flowAgile.shared.saveFailed)),
    });
  };

  const lengths: readonly number[] = SPRINT_LENGTHS.includes(current.sprintLengthDays as (typeof SPRINT_LENGTHS)[number])
    ? SPRINT_LENGTHS
    : [...SPRINT_LENGTHS, current.sprintLengthDays].sort((a, b) => a - b);
  const lengthLabel = (days: number) =>
    days % 7 === 0 ? plural(days / 7, copy.sprintLengthOption) : plural(days, copy.sprintLengthDays);

  const wipStages = stages.data ?? [];
  const renderWipLimits = () => {
    if (stages.isLoading) return <PageLoader fullScreen={false} />;
    if (wipStages.length === 0) return <p className="text-sm text-muted-foreground">{copy.wipNoStages}</p>;
    return (
      <div className="divide-y rounded-lg border">
        {wipStages.map((stage) => {
          const id = `${headingId}-wip-${stage.id}`;
          return (
            <div key={stage.id} className="flex items-center justify-between gap-4 px-3 py-2">
              <label htmlFor={id} className="flex min-w-0 items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className="size-2.5 flex-none rounded-full"
                  style={{ backgroundColor: stage.color ?? undefined }}
                />
                <span className="truncate">{stage.name}</span>
              </label>
              <NumberInput
                id={id}
                name={`wip-${stage.id}`}
                min={1}
                max={WIP_LIMIT_MAX}
                placeholder={copy.wipNone}
                value={current.wipLimits[stage.id]}
                onValueChange={(value) => setWipLimit(stage.id, value)}
                disabled={disabled}
                className="w-28"
              />
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <form className="max-w-2xl space-y-10" aria-labelledby={headingId} onSubmit={submit}>
      <h3 id={headingId} className="sr-only">
        {copy.title}
      </h3>
      {!isAdmin && <InfoBanner variant="info">{copy.managersOnly}</InfoBanner>}

      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="mb-3 text-base font-semibold">{copy.approachLabel}</legend>
        <RadioGroup
          value={current.approach}
          onValueChange={(value) => edit({ approach: value as DeliveryApproach })}
          className="grid gap-2 sm:grid-cols-2"
        >
          {DELIVERY_APPROACHES.map((approach) => {
            const id = `${headingId}-${approach}`;
            const selected = current.approach === approach;
            return (
              <label
                key={approach}
                htmlFor={id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                  selected ? 'border-foreground/40 bg-accent' : 'hover:bg-accent/50',
                  disabled && 'cursor-not-allowed opacity-70',
                )}
              >
                <RadioGroupItem id={id} value={approach} className="mt-0.5" />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium">{t.flowAgile.approaches[approach].name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.flowAgile.approaches[approach].description}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </fieldset>

      <SettingsSection title={copy.changesTitle}>
        <ul className="space-y-1.5 rounded-lg border px-3 py-3 text-sm">
          {changes.map((line) => (
            <li key={line} className="flex items-start gap-2">
              <Check aria-hidden className="mt-0.5 size-4 flex-none text-muted-foreground" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        {offerSuggestedTabs && (
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${headingId}-tabs`}
              checked={showSuggestedTabs}
              disabled={disabled}
              onCheckedChange={(checked) => setShowSuggestedTabs(checked === true)}
              aria-describedby={`${headingId}-tabs-hint`}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <label htmlFor={`${headingId}-tabs`} className="text-sm font-medium">
                {copy.showSuggestedTabs}
              </label>
              <p id={`${headingId}-tabs-hint`} className="text-xs text-muted-foreground">
                {copy.showSuggestedTabsHint}
              </p>
            </div>
          </div>
        )}
      </SettingsSection>

      {defaults.usesSprints && (
        <SettingsSection title={copy.sprintsTitle}>
          <SettingRow label={copy.sprintLength} htmlFor={`${headingId}-length`}>
            <Select
              value={String(current.sprintLengthDays)}
              onValueChange={(value) => edit({ sprintLengthDays: Number(value) })}
              disabled={disabled}
            >
              <SelectTrigger id={`${headingId}-length`} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {lengths.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {lengthLabel(days)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingsSection>
      )}

      {current.approach !== 'tasklist' && current.approach !== 'predictive' && (
        <SettingsSection title={copy.wipTitle} description={copy.wipDescription}>
          {renderWipLimits()}
        </SettingsSection>
      )}

      {defaults.usesItemTypes && (
        <SettingsSection title={copy.dodTitle} description={copy.dodDescription}>
          {current.definitionOfDone.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.dodEmpty}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {current.definitionOfDone.map((criterion, index) => (
                <li key={`${index}-${criterion}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 break-words">{criterion}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 flex-none"
                    disabled={disabled}
                    aria-label={copy.dodRemove.replace('{text}', criterion)}
                    onClick={() => removeCriterion(index)}
                  >
                    <X aria-hidden className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {current.definitionOfDone.length < DEFINITION_OF_DONE_MAX_ITEMS && (
            <div className="flex gap-2">
              <label htmlFor={`${headingId}-dod`} className="sr-only">
                {copy.dodPlaceholder}
              </label>
              <Input
                id={`${headingId}-dod`}
                name="definitionOfDone"
                value={newCriterion}
                maxLength={DEFINITION_OF_DONE_ITEM_MAX}
                placeholder={copy.dodPlaceholder}
                disabled={disabled}
                enterKeyHint="done"
                onChange={(event) => setNewCriterion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    addCriterion();
                  }
                }}
              />
              <Button type="button" variant="outline" disabled={disabled || !newCriterion.trim()} onClick={addCriterion}>
                <Plus aria-hidden className="size-4" />
                {copy.dodAdd}
              </Button>
            </div>
          )}
        </SettingsSection>
      )}

      <div className="flex items-center justify-end gap-2 border-t pt-4">
        {draft && (
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setDraft(null)}>
            {t.flowAgile.shared.cancel}
          </Button>
        )}
        <Button type="submit" disabled={disabled || !draft}>
          {save.isPending ? t.flowAgile.shared.saving : t.flowAgile.shared.save}
        </Button>
      </div>
    </form>
  );
}
