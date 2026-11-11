/**
 * Field pieces the phone route editor shares between its actions: a labelled
 * field with its error, the language / team / voice agent pickers, and the
 * ring time, maximum wait, unanswered and voicemail fields that both "ring
 * agents" and the keypad menu use.
 */

import type { ReactNode } from 'react';
import {
  DESK_PHONE_MAX_WAIT_SECONDS_RANGE,
  DESK_PHONE_RING_SECONDS_RANGE,
  DESK_PHONE_TEXT_MAX_LENGTH,
} from '@weldsuite/core-api-client/schemas/desk-phone';
import { Label } from '@weldsuite/ui/components/label';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { getTranslations } from '@/lib/i18n';
import type { DeskTeam } from '@/hooks/queries/use-desk-routing-queries';
import type { DeskPhoneVoiceAgent } from '@/hooks/queries/use-desk-phone-settings-queries';
import {
  COMMON_LANGUAGES,
  DEFAULT_MAX_WAIT_SECONDS,
  DEFAULT_RING_SECONDS,
  usesQueue,
  usesVoicemail,
  type FieldError,
  type FormErrors,
  type PhoneRouteFormValues,
  type UnansweredAction,
} from './phone-route-form';

export type PhoneSettingsStrings = ReturnType<typeof getTranslations<'helpdesk'>>['phoneSettings'];

/** The value the pickers use for "no team" / "no choice"; Radix items cannot be empty. */
export const NONE = '__none__';

/** The text of a field error: the server's own words, or the translated rule. */
export function errorText(error: FieldError | undefined, t: PhoneSettingsStrings, field = ''): string | null {
  if (!error) return null;
  if ('message' in error) return error.message;
  const max = field.endsWith('.label') ? 100 : DESK_PHONE_TEXT_MAX_LENGTH;
  const range = error.code === 'maxWaitRange' ? DESK_PHONE_MAX_WAIT_SECONDS_RANGE : DESK_PHONE_RING_SECONDS_RANGE;
  return t.errors[error.code]
    .replace('{min}', String(range.min))
    .replace('{max}', String(error.code === 'tooLong' ? max : range.max));
}

export function Field({
  label,
  hint,
  htmlFor,
  error,
  children,
}: Readonly<{ label: string; hint?: string; htmlFor?: string; error?: string | null; children: ReactNode }>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function LanguageField({
  value,
  onChange,
  t,
  error,
}: Readonly<{ value: string; onChange: (value: string) => void; t: PhoneSettingsStrings; error?: string | null }>) {
  const labels: Record<string, string> = t.languages;
  const tags: string[] = [...COMMON_LANGUAGES];
  // A stored tag outside the short list stays selectable.
  if (value && !tags.includes(value)) tags.push(value);
  return (
    <Field label={t.fields.language} hint={t.fields.languageHint} error={error}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={t.fields.language} aria-invalid={Boolean(error)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {tags.map((tag) => (
            <SelectItem key={tag} value={tag}>
              {labels[tag] ? `${labels[tag]} (${tag})` : tag}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** A team, or every available agent. */
export function TeamSelect({
  value,
  onChange,
  teams,
  t,
  label,
  hint,
  error,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  teams: DeskTeam[];
  t: PhoneSettingsStrings;
  label: string;
  hint?: string;
  error?: string | null;
}>) {
  const known = teams.some((team) => team.id === value);
  return (
    <Field label={label} hint={hint} error={error}>
      <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
        <SelectTrigger aria-label={label} aria-invalid={Boolean(error)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t.fields.teamAll}</SelectItem>
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.isActive ? team.name : t.fields.teamInactive.replace('{name}', team.name)}
            </SelectItem>
          ))}
          {value && !known && <SelectItem value={value}>{value}</SelectItem>}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function VoiceAgentSelect({
  value,
  onChange,
  agents,
  t,
  label,
  error,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  agents: DeskPhoneVoiceAgent[];
  t: PhoneSettingsStrings;
  label: string;
  error?: string | null;
}>) {
  // A disabled agent stays visible when it is the current pick, but cannot be newly chosen.
  const options = agents.filter((agent) => agent.enabled || agent.id === value);
  const known = agents.some((agent) => agent.id === value);
  return (
    <Field label={label} error={error}>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger aria-label={label} aria-invalid={Boolean(error)}>
          <SelectValue placeholder={t.fields.voiceAgentPlaceholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.enabled ? agent.name : t.fields.voiceAgentDisabled.replace('{name}', agent.name)}
            </SelectItem>
          ))}
          {value && !known && <SelectItem value={value}>{value}</SelectItem>}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SpokenTextField({
  id,
  label,
  hint,
  value,
  onChange,
  error,
  rows = 2,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  rows?: number;
}>) {
  return (
    <Field label={label} hint={hint} htmlFor={id} error={error}>
      <Textarea
        id={id}
        rows={rows}
        maxLength={DESK_PHONE_TEXT_MAX_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
      />
    </Field>
  );
}

/**
 * Ring time, maximum wait, what happens when nobody answers and the voicemail
 * greeting: shown only for what the route can do (a queue, a voicemail).
 */
export function QueueFields({
  values,
  set,
  errors,
  t,
}: Readonly<{
  values: PhoneRouteFormValues;
  set: <K extends keyof PhoneRouteFormValues>(key: K, value: PhoneRouteFormValues[K]) => void;
  errors: FormErrors;
  t: PhoneSettingsStrings;
}>) {
  const ringHint = t.fields.ringSecondsHint
    .replace('{min}', String(DESK_PHONE_RING_SECONDS_RANGE.min))
    .replace('{max}', String(DESK_PHONE_RING_SECONDS_RANGE.max))
    .replace('{default}', String(DEFAULT_RING_SECONDS));
  const waitHint = t.fields.maxWaitSecondsHint
    .replace('{min}', String(DESK_PHONE_MAX_WAIT_SECONDS_RANGE.min))
    .replace('{max}', String(DESK_PHONE_MAX_WAIT_SECONDS_RANGE.max))
    .replace('{default}', String(DEFAULT_MAX_WAIT_SECONDS));
  return (
    <div className="space-y-4" data-testid="phone-queue-fields">
      {usesQueue(values) && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.fields.ringSeconds} hint={ringHint} htmlFor="phone-ring-seconds" error={errorText(errors.ringSeconds, t)}>
              <div className="flex items-center gap-2">
                <NumberInput
                  id="phone-ring-seconds"
                  className="w-28"
                  value={values.ringSeconds}
                  onValueChange={(n) => set('ringSeconds', n)}
                  aria-invalid={Boolean(errors.ringSeconds)}
                />
                <span className="text-sm text-muted-foreground">{t.fields.seconds}</span>
              </div>
            </Field>
            <Field label={t.fields.maxWaitSeconds} hint={waitHint} htmlFor="phone-max-wait" error={errorText(errors.maxWaitSeconds, t)}>
              <div className="flex items-center gap-2">
                <NumberInput
                  id="phone-max-wait"
                  className="w-28"
                  value={values.maxWaitSeconds}
                  onValueChange={(n) => set('maxWaitSeconds', n)}
                  aria-invalid={Boolean(errors.maxWaitSeconds)}
                />
                <span className="text-sm text-muted-foreground">{t.fields.seconds}</span>
              </div>
            </Field>
          </div>
          <Field label={t.fields.whenUnanswered}>
            <Select value={values.whenUnanswered} onValueChange={(v) => set('whenUnanswered', v as UnansweredAction)}>
              <SelectTrigger aria-label={t.fields.whenUnanswered}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="voicemail">{t.fields.unansweredVoicemail}</SelectItem>
                <SelectItem value="hangup">{t.fields.unansweredHangup}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
      {usesVoicemail(values) && (
        <SpokenTextField
          id="phone-voicemail-greeting"
          label={t.fields.voicemailGreeting}
          hint={t.fields.voicemailGreetingHint}
          value={values.voicemailGreeting}
          onChange={(v) => set('voicemailGreeting', v)}
          error={errorText(errors.voicemailGreeting, t)}
        />
      )}
    </div>
  );
}
