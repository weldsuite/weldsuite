/**
 * Inputs of the risk forms: the 1-5 rating selects, the response (strategy)
 * toggle group and the live score, all built from the shadcn `Field`
 * components.
 */

import { useId } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { RISK_STRATEGIES } from '@weldsuite/app-api-client/schemas/project-control';
import type { RiskBand } from '@weldsuite/app-api-client/domains/project-control';
import { Badge } from '@weldsuite/ui/components/badge';
import { Field, FieldDescription, FieldTitle } from '@weldsuite/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import { impactName, probabilityName } from '../_lib/copy';
import { RATINGS, riskBand, riskScore } from '../_lib/risk';
import { FieldFrame, NONE, ROW_CONTROL } from './form-fields';

interface RatingFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  kind: 'probability' | 'impact';
  /** Offers a "not set" choice (the after-mitigation rating is optional). */
  nullable?: boolean;
}

/** A 1-5 rating as a property row: a select of "3 · Possible". */
export function RatingField<T extends FieldValues>({ control, name, label, kind, nullable }: Readonly<RatingFieldProps<T>>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const nameOf = kind === 'probability' ? probabilityName : impactName;
  const id = useId();
  const emptyValue = nullable ? NONE : '';
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} label={label} error={fieldState.error} inline>
          <Select
            name={field.name}
            value={field.value == null ? emptyValue : String(field.value)}
            onValueChange={(value) => field.onChange(value === NONE ? null : Number(value))}
          >
            <SelectTrigger id={id} ref={field.ref} onBlur={field.onBlur} className={ROW_CONTROL} aria-invalid={fieldState.invalid}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {nullable ? <SelectItem value={NONE}>{copy.form.residualNotSet}</SelectItem> : null}
              {RATINGS.map((rating) => (
                <SelectItem key={rating} value={String(rating)}>
                  {rating} · {nameOf(copy, rating)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldFrame>
      )}
    />
  );
}

const BAND_BADGE: Readonly<Record<RiskBand, 'success' | 'warning' | 'destructive'>> = {
  low: 'success',
  medium: 'warning',
  high: 'destructive',
  critical: 'destructive',
};

interface ScoreFieldProps {
  probability: number | null | undefined;
  impact: number | null | undefined;
  /** The score before this change, shown as "was 12". */
  previousScore?: number | null;
  /** Shown below instead of what the band asks of the team. */
  hint?: string;
}

/** The score of the chosen probability and impact as a property row, with what the band asks of the team below. */
export function ScoreField({ probability, impact, previousScore, hint }: Readonly<ScoreFieldProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  if (!probability || !impact) return hint ? <FieldDescription>{hint}</FieldDescription> : null;
  const score = riskScore(probability, impact);
  const band = riskBand(score);
  const was = previousScore != null && previousScore !== score ? format(copy.assess.was, { score: previousScore }) : null;
  return (
    <Field aria-live="polite">
      <Field orientation="horizontal">
        <FieldTitle>{copy.form.score}</FieldTitle>
        <Badge variant={BAND_BADGE[band]}>
          {score} · {copy.bands[band]}
        </Badge>
      </Field>
      <FieldDescription>{[was, hint ?? copy.bandGuidance[band]].filter(Boolean).join(' · ')}</FieldDescription>
    </Field>
  );
}

interface StrategyPickerProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}

/** The four responses to a risk, as a toggle group with the chosen one's hint below. Choosing the active one again clears it. */
export function StrategyPicker({ value, onChange }: Readonly<StrategyPickerProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid.strategy;
  const labelId = useId();
  const chosen = RISK_STRATEGIES.find((strategy) => strategy === value);
  return (
    <Field>
      <FieldTitle id={labelId}>{copy.label}</FieldTitle>
      <ToggleGroup
        type="single"
        variant="outline"
        aria-labelledby={labelId}
        value={value ?? ''}
        onValueChange={(next) => onChange(next || null)}
      >
        {RISK_STRATEGIES.map((strategy) => (
          <ToggleGroupItem key={strategy} value={strategy}>
            {copy[strategy].name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {chosen ? <FieldDescription>{copy[chosen].hint}</FieldDescription> : null}
    </Field>
  );
}
