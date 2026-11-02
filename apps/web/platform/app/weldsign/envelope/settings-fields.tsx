/**
 * The pieces the settings of a draft and the settings step of a template
 * have in common: message, signing order, reminders, the summary and the list
 * of what is still missing. Each one saves through the callback it is given, so
 * they know nothing about whether they edit a request or a template.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { SignSettingsInput } from '@/hooks/queries/use-weldsign-queries';
import type { ReadinessProblem } from '../lib/readiness';

const DEFAULT_REMINDERS = { reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 };
const NO_REMINDERS = { reminderAfterDays: null, reminderEveryDays: null, reminderMaxCount: null };

interface MessageFieldProps {
  message: string | null;
  disabled: boolean;
  onSave: (message: string | null) => void;
}

/** The message recipients get, saved when the box loses focus. */
export function MessageField({ message, disabled, onSave }: Readonly<MessageFieldProps>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.review;
  const [value, setValue] = useState(message ?? '');
  useEffect(() => setValue(message ?? ''), [message]);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="sign-message">{tr.message}</Label>
      <Textarea
        id="sign-message"
        rows={4}
        maxLength={5000}
        value={value}
        disabled={disabled}
        placeholder={tr.messagePlaceholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const next = value.trim() || null;
          if (next !== (message ?? null)) onSave(next);
        }}
      />
    </div>
  );
}

interface SigningOrderToggleProps {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  /** Just the switch and its label: no box, and no line saying what the order does. */
  plain?: boolean;
}

export function SigningOrderToggle({ checked, disabled, onChange, plain = false }: Readonly<SigningOrderToggleProps>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.recipients;
  return (
    <label className={cn('flex gap-3', plain ? 'items-center' : 'items-start rounded-lg border p-3')}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} className={cn(!plain && 'mt-0.5')} />
      <span>
        <span className="block text-sm font-medium">{tr.signingOrder}</span>
        {!plain && <span className="block text-xs text-muted-foreground">{tr.signingOrderHint}</span>}
      </span>
    </label>
  );
}

interface ReminderSettingsProps {
  settings: Pick<SignEnvelopeDetail, 'reminderAfterDays' | 'reminderEveryDays' | 'reminderMaxCount'>;
  editable: boolean;
  save: (input: SignSettingsInput) => void;
}

/** Automatic reminders: on or off, and when and how often they go out. */
export function ReminderSettings({ settings, editable, save }: Readonly<ReminderSettingsProps>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.review;
  const remindersOn = settings.reminderAfterDays !== null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-medium">{tr.reminders}</span>
          <span className="block text-xs text-muted-foreground">{tr.remindersOn}</span>
        </span>
        <Switch
          checked={remindersOn}
          disabled={!editable}
          onCheckedChange={(on) => save(on ? DEFAULT_REMINDERS : NO_REMINDERS)}
        />
      </label>
      {remindersOn && (
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <NumberSetting
            id="sign-reminder-after"
            label={tr.reminderAfter}
            value={settings.reminderAfterDays}
            min={1}
            max={90}
            disabled={!editable}
            onCommit={(reminderAfterDays) => save({ reminderAfterDays })}
          />
          <NumberSetting
            id="sign-reminder-every"
            label={tr.reminderEvery}
            value={settings.reminderEveryDays}
            min={1}
            max={90}
            disabled={!editable}
            onCommit={(reminderEveryDays) => save({ reminderEveryDays })}
          />
          <NumberSetting
            id="sign-reminder-max"
            label={tr.reminderMax}
            value={settings.reminderMaxCount}
            min={0}
            max={10}
            disabled={!editable}
            onCommit={(reminderMaxCount) => save({ reminderMaxCount })}
          />
        </div>
      )}
    </section>
  );
}

/** A heading over a row of counts (documents, recipients, fields). */
export function SummaryStats({ title, stats }: Readonly<{ title: string; stats: { label: string; value: number }[] }>) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <dl className="grid grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="text-xl font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The words for what can still be missing. */
export interface ProblemMessages {
  noDocuments: string;
  noSigners: string;
  /** `{name}` is the signer's (or the role's) name. */
  signerWithoutSignature: string;
}

/** One thing still missing, in words. */
export function describeProblem(problem: ReadinessProblem, messages: ProblemMessages, format: ReturnType<typeof useI18n>['format']): string {
  if (problem.kind === 'no_documents') return messages.noDocuments;
  if (problem.kind === 'no_signers') return messages.noSigners;
  return format(messages.signerWithoutSignature, { name: problem.name });
}

/** A problem's key in a list: one per kind, or per signer. */
export const problemKey = (problem: ReadinessProblem): string => (problem.kind === 'signer_without_signature' ? problem.recipientId : problem.kind);

interface ReadinessChecklistProps {
  problems: ReadinessProblem[];
  heading: string;
  messages: ProblemMessages & { ready: string };
}

/** What still stands between this draft (or template) and being sendable, or a tick when nothing does. */
export function ReadinessChecklist({ problems, heading, messages }: Readonly<ReadinessChecklistProps>) {
  const { format } = useI18n();

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4">
      <h3 className="text-sm font-medium">{heading}</h3>
      {problems.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-4" />
          {messages.ready}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {problems.map((problem) => (
            <li key={problemKey(problem)} className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-amber-600" />
              {describeProblem(problem, messages, format)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface NumberSettingProps {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}

function NumberSetting({ id, label, value, min, max, disabled, onCommit }: Readonly<NumberSettingProps>) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number.parseInt(text, 10);
          if (Number.isNaN(n)) return setText(value === null ? '' : String(value));
          const clamped = Math.min(Math.max(n, min), max);
          setText(String(clamped));
          if (clamped !== value) onCommit(clamped);
        }}
      />
    </div>
  );
}
