/**
 * Step 4: the message, reminders, and what is still missing. Sending arrives in
 * phase 2 of docs/plans/weldsign.md; until then the button stays disabled.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { SignEnvelopeDetail, UpdateSignEnvelopeInput } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { readinessProblems } from '../lib/readiness';

const DEFAULT_REMINDERS = { reminderAfterDays: 3, reminderEveryDays: 3, reminderMaxCount: 3 };

export function ReviewStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const tr = t.weldsign.editor.review;
  const update = useUpdateSignEnvelope(envelope.id);
  const save = (input: UpdateSignEnvelopeInput) => update.mutate(input);

  const [message, setMessage] = useState(envelope.message ?? '');
  useEffect(() => setMessage(envelope.message ?? ''), [envelope.message]);

  const remindersOn = envelope.reminderAfterDays !== null;
  const problems = readinessProblems(envelope);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{tr.title}</h2>
        <p className="text-sm text-muted-foreground">{tr.description}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sign-message">{tr.message}</Label>
        <Textarea
          id="sign-message"
          rows={4}
          maxLength={5000}
          value={message}
          disabled={!editable}
          placeholder={tr.messagePlaceholder}
          onChange={(e) => setMessage(e.target.value)}
          onBlur={() => {
            const next = message.trim() || null;
            if (next !== (envelope.message ?? null)) save({ message: next });
          }}
        />
      </div>

      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-sm font-medium">{tr.reminders}</span>
            <span className="block text-xs text-muted-foreground">{tr.remindersOn}</span>
          </span>
          <Switch
            checked={remindersOn}
            disabled={!editable}
            onCheckedChange={(on) =>
              save(on ? DEFAULT_REMINDERS : { reminderAfterDays: null, reminderEveryDays: null, reminderMaxCount: null })
            }
          />
        </label>
        {remindersOn && (
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberSetting
              id="sign-reminder-after"
              label={tr.reminderAfter}
              value={envelope.reminderAfterDays}
              min={1}
              max={90}
              disabled={!editable}
              onCommit={(reminderAfterDays) => save({ reminderAfterDays })}
            />
            <NumberSetting
              id="sign-reminder-every"
              label={tr.reminderEvery}
              value={envelope.reminderEveryDays}
              min={1}
              max={90}
              disabled={!editable}
              onCommit={(reminderEveryDays) => save({ reminderEveryDays })}
            />
            <NumberSetting
              id="sign-reminder-max"
              label={tr.reminderMax}
              value={envelope.reminderMaxCount}
              min={0}
              max={10}
              disabled={!editable}
              onCommit={(reminderMaxCount) => save({ reminderMaxCount })}
            />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{tr.summary}</h3>
        <dl className="grid grid-cols-3 gap-3">
          <Stat label={tr.summaryDocuments} value={envelope.documents.length} />
          <Stat label={tr.summaryRecipients} value={envelope.recipientList.length} />
          <Stat label={tr.summaryFields} value={envelope.fields.length} />
        </dl>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h3 className="text-sm font-medium">{tr.problems}</h3>
        {problems.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" />
            {tr.ready}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {problems.map((problem) => (
              <li key={problem.kind === 'signer_without_signature' ? problem.recipientId : problem.kind} className="flex items-center gap-2 text-sm">
                <AlertTriangle className="size-4 shrink-0 text-amber-600" />
                {problem.kind === 'no_documents' && tr.noDocuments}
                {problem.kind === 'no_signers' && tr.noSigners}
                {problem.kind === 'signer_without_signature' && format(tr.signerWithoutSignature, { name: problem.name })}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editable && (
        <div className="flex flex-col items-end gap-2">
          <Button disabled>
            <Send />
            {tr.send}
          </Button>
          <p className="text-xs text-muted-foreground">{tr.sendComingSoon}</p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function NumberSetting({
  id,
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: Readonly<{ id: string; label: string; value: number | null; min: number; max: number; disabled: boolean; onCommit: (value: number) => void }>) {
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
