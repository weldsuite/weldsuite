/**
 * The payment reminder workflow of one entity (Settings → Entities → (entity)
 * → WeldBooks, edition feature `books-reminders`): switch it on, set up to
 * three steps (days after the due date, sent automatically or suggested in To
 * process, which e-mail template, which one is the final notice) and, for a
 * Dutch entity, whether the final notice adds the statutory collection costs
 * (WIK) and interest.
 */

import { useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useReminderSettings, useUpdateReminderSettings } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { ReminderSettings, ReminderStep } from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';

const TEMPLATES = ['reminder1', 'reminder2', 'reminder3'] as const;
/** The server takes a rate between 0 and 100 percent a year. */
const MAX_RATE = 100;

interface Draft {
  enabled: boolean;
  steps: ReminderStep[];
  wikEnabled: boolean;
  interest: boolean;
  commercialRate: string;
  consumerRate: string;
}

function toDraft(settings: ReminderSettings): Draft {
  return {
    enabled: settings.enabled,
    steps: settings.steps.map((step) => ({ ...step })),
    wikEnabled: settings.statutoryCosts.enabled,
    interest: settings.statutoryCosts.interest,
    commercialRate: String(settings.statutoryCosts.commercialRate),
    consumerRate: String(settings.statutoryCosts.consumerRate),
  };
}

function rateOf(text: string): number {
  return Number(text.trim().replace(',', '.'));
}

const rateValid = (text: string) => text.trim() !== '' && Number.isFinite(rateOf(text)) && rateOf(text) >= 0 && rateOf(text) <= MAX_RATE;

type Problem = 'daysNotGrowing' | 'daysInvalid' | 'rateInvalid' | 'twoFinal';

/** What stops the workflow from being saved, or null. Days must grow from step to step. */
export function reminderProblem(draft: Pick<Draft, 'steps' | 'wikEnabled' | 'commercialRate' | 'consumerRate'>, statutoryAvailable: boolean): Problem | null {
  for (const [index, step] of draft.steps.entries()) {
    if (!Number.isInteger(step.daysAfterDue) || step.daysAfterDue < 0 || step.daysAfterDue > 365) return 'daysInvalid';
    if (index > 0 && step.daysAfterDue <= draft.steps[index - 1].daysAfterDue) return 'daysNotGrowing';
  }
  if (draft.steps.filter((step) => step.final).length > 1) return 'twoFinal';
  if (statutoryAvailable && draft.wikEnabled && !(rateValid(draft.commercialRate) && rateValid(draft.consumerRate))) return 'rateInvalid';
  return null;
}

type RemindersCopy = ReturnType<typeof useI18n>['t']['weldbooksSales']['remindersSettings'];

interface StepCardProps {
  step: ReminderStep;
  index: number;
  setStep: (index: number, patch: Partial<ReminderStep>) => void;
  copy: RemindersCopy;
  templateLabels: Readonly<Record<string, string>>;
}

function StepCard({ step, index, setStep, copy, templateLabels }: Readonly<StepCardProps>) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid={`reminder-step-${step.level}`}>
      <p className="text-sm font-medium">{copy.step.replace('{level}', String(step.level))}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`step-${step.level}-days`}>{copy.daysAfterDue}</Label>
          <Input
            id={`step-${step.level}-days`}
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            value={Number.isNaN(step.daysAfterDue) ? '' : step.daysAfterDue}
            onChange={(event) => setStep(index, { daysAfterDue: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`step-${step.level}-auto`}>{copy.how}</Label>
          <Select value={step.auto ? 'auto' : 'ask'} onValueChange={(value) => setStep(index, { auto: value === 'auto' })}>
            <SelectTrigger id={`step-${step.level}-auto`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{copy.auto}</SelectItem>
              <SelectItem value="ask">{copy.ask}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`step-${step.level}-template`}>{copy.template}</Label>
          <Select value={step.template} onValueChange={(template) => setStep(index, { template })}>
            <SelectTrigger id={`step-${step.level}-template`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATES.map((template) => (
                <SelectItem key={template} value={template}>
                  {templateLabels[template] ?? template}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`step-${step.level}-final`}>{copy.final}</Label>
        <Switch id={`step-${step.level}-final`} checked={step.final} onCheckedChange={(final) => setStep(index, { final })} />
      </div>
    </div>
  );
}

interface WikSectionProps {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  canEdit: boolean;
  defaults: ReminderSettings['defaultRates'];
  copy: RemindersCopy;
}

function WikSection({ draft, setDraft, canEdit, defaults, copy }: Readonly<WikSectionProps>) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3" disabled={!canEdit} data-testid="wik-section">
      <legend className="px-1 text-sm font-medium">{copy.wikTitle}</legend>
      <p className="text-[13px] text-muted-foreground">{copy.wikExplanation}</p>
      <ul className="m-0 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
        <li>{copy.wikBusiness}</li>
        <li>{copy.wikConsumer}</li>
      </ul>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="wik-enabled">{copy.wikEnable}</Label>
        <Switch id="wik-enabled" checked={draft.wikEnabled} onCheckedChange={(wikEnabled) => setDraft((current) => ({ ...current, wikEnabled }))} />
      </div>
      {draft.wikEnabled ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="wik-interest">{copy.wikInterest}</Label>
            <Switch id="wik-interest" checked={draft.interest} onCheckedChange={(interest) => setDraft((current) => ({ ...current, interest }))} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wik-commercial">{copy.commercialRate}</Label>
              <Input
                id="wik-commercial"
                inputMode="decimal"
                value={draft.commercialRate}
                aria-invalid={rateValid(draft.commercialRate) ? undefined : true}
                aria-describedby="wik-commercial-default"
                onChange={(event) => setDraft((current) => ({ ...current, commercialRate: event.target.value }))}
              />
              <p id="wik-commercial-default" className="text-xs text-muted-foreground">
                {defaults ? copy.defaultRate.replace('{rate}', String(defaults.commercialRate)) : copy.rateHint}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wik-consumer">{copy.consumerRate}</Label>
              <Input
                id="wik-consumer"
                inputMode="decimal"
                value={draft.consumerRate}
                aria-invalid={rateValid(draft.consumerRate) ? undefined : true}
                aria-describedby="wik-consumer-default"
                onChange={(event) => setDraft((current) => ({ ...current, consumerRate: event.target.value }))}
              />
              <p id="wik-consumer-default" className="text-xs text-muted-foreground">
                {defaults ? copy.defaultRate.replace('{rate}', String(defaults.consumerRate)) : copy.rateHint}
              </p>
            </div>
          </div>
        </>
      ) : null}
    </fieldset>
  );
}

function RemindersForm({ settings }: Readonly<{ settings: ReminderSettings }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.remindersSettings;
  const canEdit = useCan('accounts:update');
  const save = useUpdateReminderSettings();
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const initial = toDraft(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const problem = reminderProblem(draft, settings.statutoryAvailable);
  const problems = copy.problems as Readonly<Record<string, string>>;
  const templateLabels = t.weldbooksSales.templates.kinds as Readonly<Record<string, string>>;
  const defaults = settings.defaultRates;

  const setStep = (index: number, patch: Partial<ReminderStep>) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => {
        if (i === index) return { ...step, ...patch };
        // Only one step is the final notice.
        return patch.final === true ? { ...step, final: false } : step;
      }),
    }));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (problem || !dirty) return;
    save.mutate(
      {
        enabled: draft.enabled,
        steps: draft.steps,
        ...(settings.statutoryAvailable
          ? {
              statutoryCosts: {
                enabled: draft.wikEnabled,
                interest: draft.interest,
                commercialRate: rateOf(draft.commercialRate),
                consumerRate: rateOf(draft.consumerRate),
              },
            }
          : {}),
      },
      {
        onSuccess: () => toast.success(copy.saved),
        onError: (error) => toast.error(copy.saveFailed, { description: error instanceof Error ? error.message : undefined }),
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="reminders-enabled">{copy.enable}</Label>
            <p id="reminders-enabled-hint" className="text-xs text-muted-foreground">
              {copy.enableHint}
            </p>
          </div>
          <Switch
            id="reminders-enabled"
            aria-describedby="reminders-enabled-hint"
            checked={draft.enabled}
            disabled={!canEdit}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
        </div>

        <fieldset className="space-y-3" disabled={!canEdit}>
          <legend className="mb-1 text-sm font-medium">{copy.steps}</legend>
          {draft.steps.map((step, index) => (
            <StepCard key={step.level} step={step} index={index} setStep={setStep} copy={copy} templateLabels={templateLabels} />
          ))}
        </fieldset>

        {settings.statutoryAvailable ? (
          <WikSection draft={draft} setDraft={setDraft} canEdit={canEdit} defaults={defaults} copy={copy} />
        ) : null}

        {problem ? (
          <InfoBanner variant="warning">{problems[problem] ?? copy.saveFailed}</InfoBanner>
        ) : null}

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || problem !== null || save.isPending}>
              {save.isPending ? copy.saving : copy.save}
            </Button>
            {dirty ? (
              <Button type="button" variant="ghost" onClick={() => setDraft(toDraft(settings))}>
                {copy.discard}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </form>
  );
}

function RemindersBody({ query, copy, formKey }: Readonly<{ query: ReturnType<typeof useReminderSettings>; copy: RemindersCopy; formKey: string }>) {
  if (query.isError) {
    return (
      <CardContent>
        <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} />
      </CardContent>
    );
  }
  if (query.data) return <RemindersForm key={formKey} settings={query.data} />;
  return (
    <CardContent>
      <InlineSpinner />
    </CardContent>
  );
}

export function RemindersCard() {
  const { t } = useI18n();
  const copy = t.weldbooksSales.remindersSettings;
  const query = useReminderSettings();
  // After a save the server's answer replaces the form's starting point.
  const formKey = query.data ? JSON.stringify(query.data) : 'loading';
  return (
    <Card data-testid="reminders-settings-card">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <RemindersBody query={query} copy={copy} formKey={formKey} />
    </Card>
  );
}
