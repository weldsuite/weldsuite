/**
 * Inputs of the risk forms: the 1-5 rating buttons, the response (strategy)
 * cards and the live score card.
 */

import { RISK_STRATEGIES } from '@weldsuite/app-api-client/schemas/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { impactName, probabilityName } from '../_lib/copy';
import { RATINGS, riskBand, riskScore } from '../_lib/risk';
import { BAND_STYLES } from '../_lib/styles';

interface RatingPickerProps {
  /** The group label, also its accessible name. */
  label: string;
  kind: 'probability' | 'impact';
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  /** Offers a "not set" choice (the after-mitigation rating is optional). */
  nullable?: boolean;
  error?: string;
  disabled?: boolean;
}

/** Five buttons, 1 to 5, each with its name ("Likely", "Major"). */
export function RatingPicker({ label, kind, value, onChange, nullable, error, disabled }: Readonly<RatingPickerProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const nameOf = kind === 'probability' ? probabilityName : impactName;

  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 flex w-full items-center justify-between text-sm font-medium">
        {label}
        {nullable && value != null ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs font-normal text-muted-foreground underline-offset-2 hover:underline"
          >
            {copy.form.residualNotSet}
          </button>
        ) : null}
      </legend>
      <div className="grid grid-cols-5 gap-1.5">
        {RATINGS.map((rating) => {
          const on = value === rating;
          return (
            <button
              key={rating}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(rating)}
              className={cn(
                'flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1.5 text-center outline-none transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
                on ? 'border-foreground bg-foreground text-background' : 'bg-background hover:bg-accent',
              )}
            >
              <span className="text-[15px] leading-none font-semibold">{rating}</span>
              <span className="text-[11px] leading-tight">{nameOf(copy, rating)}</span>
            </button>
          );
        })}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </fieldset>
  );
}

interface StrategyPickerProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}

/** The four responses to a risk, as cards. Choosing the active one again clears it. */
export function StrategyPicker({ value, onChange }: Readonly<StrategyPickerProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid.strategy;
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">{copy.label}</legend>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {RISK_STRATEGIES.map((strategy) => {
          const on = value === strategy;
          return (
            <button
              key={strategy}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? null : strategy)}
              className={cn(
                'rounded-lg border px-2 py-2 text-left outline-none transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                on ? 'border-foreground bg-foreground text-background' : 'bg-background hover:bg-accent',
              )}
            >
              <div className="text-[13px] font-semibold">{copy[strategy].name}</div>
              <div className={cn('mt-0.5 text-[11px] leading-snug', on ? 'text-background/80' : 'text-muted-foreground')}>
                {copy[strategy].hint}
              </div>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

interface ScoreCardProps {
  probability: number | null | undefined;
  impact: number | null | undefined;
  /** The score before this change, shown as "was 12". */
  previousScore?: number | null;
}

/** The score of the chosen probability and impact, with the band and what it asks of the team. */
export function ScoreCard({ probability, impact, previousScore }: Readonly<ScoreCardProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  if (!probability || !impact) return null;
  const score = riskScore(probability, impact);
  const band = riskBand(score);
  return (
    <div aria-live="polite" className="flex items-center gap-3.5 rounded-lg border bg-muted/40 px-4 py-3.5">
      <span
        className={cn(
          'inline-flex h-11 min-w-14 items-center justify-center rounded-lg px-2.5 text-xl font-bold tabular-nums',
          BAND_STYLES[band].badge,
        )}
      >
        {score}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold">
          {format(copy.form.scoreOf, { band: copy.bands[band] })}
          <span className="font-normal text-muted-foreground">
            {' · '}
            {format(copy.form.scoreFormula, { probability, impact })}
            {previousScore != null && previousScore !== score ? ` · ${format(copy.assess.was, { score: previousScore })}` : ''}
          </span>
        </div>
        <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{copy.bandGuidance[band]}</div>
      </div>
    </div>
  );
}
