'use client';

import { useState, type FormEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { todayInZone } from '@/lib/date';
import type { HrTaxElection } from '@/lib/payroll/types';
import { Button } from '@/components/ui/primitives';
import { ElectionCard, SignatureBlock } from '@/components/payroll/election-parts';
import { useSignElection } from '@/components/payroll/use-sign-election';

type Choice = 'yes' | 'no';

/** The signed election's answer, or null when it is missing or unreadable. */
function readChoice(election: HrTaxElection | null): Choice | null {
  const applyCredit = election?.data.applyCredit;
  if (typeof applyCredit !== 'boolean') return null;
  return applyCredit ? 'yes' : 'no';
}

function summaryFor(choice: Choice | null, t: { nl: { summaryYes: string; summaryNo: string } }): string | null {
  if (choice === 'yes') return t.nl.summaryYes;
  if (choice === 'no') return t.nl.summaryNo;
  return null;
}

function NlForm({
  slug,
  employerName,
  initialChoice,
  onDone,
  onCancel,
}: Readonly<{
  slug: string;
  employerName: string | null;
  initialChoice: Choice | null;
  onDone: () => void;
  onCancel: (() => void) | null;
}>) {
  const { dict, format, timeZone } = useI18n();
  const t = dict.payroll.taxForms;
  const [choice, setChoice] = useState<Choice | null>(initialChoice);
  const [name, setName] = useState('');
  const { submitting, error, setError, sign } = useSignElection(slug);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (choice === null) {
      setError(dict.payroll.errors.choiceRequired);
      return;
    }
    if (!name.trim()) {
      setError(dict.payroll.errors.signatureRequired);
      return;
    }
    const stored = await sign({
      kind: 'nl_loonheffingskorting',
      effectiveFrom: todayInZone(timeZone),
      data: { applyCredit: choice === 'yes' },
      signatureName: name.trim(),
    });
    if (stored) onDone();
  }

  const options: Array<{ value: Choice; label: string }> = [
    { value: 'yes', label: t.nl.yes },
    { value: 'no', label: t.nl.no },
  ];

  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700 mb-1.5">
          {format(t.nl.question, { employer: employerName ?? t.yourEmployer })}
        </legend>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex items-center gap-3 rounded-md border border-gray-200 p-3 text-sm text-gray-800 cursor-pointer has-[:checked]:border-gray-900 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-400"
          >
            <input
              type="radio"
              name="applyCredit"
              value={option.value}
              checked={choice === option.value}
              onChange={() => {
                setChoice(option.value);
                setError(null);
              }}
              className="h-4 w-4"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <SignatureBlock id="nl-signature" name={name} onNameChange={setName} submitting={submitting} error={error} />
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          {dict.common.cancel}
        </Button>
      )}
    </form>
  );
}

/** NL: whether {employer} applies the loonheffingskorting, signed with a typed name. */
export function NlTaxFormCard({
  slug,
  employerName,
  election,
}: Readonly<{ slug: string; employerName: string | null; election: HrTaxElection | null }>) {
  const { dict } = useI18n();
  const t = dict.payroll.taxForms;
  const current = readChoice(election);
  return (
    <ElectionCard
      title={t.nl.title}
      intro={t.nl.explanation}
      election={election}
      summary={summaryFor(current, t)}
    >
      {({ close, canCancel }) => (
        <NlForm
          slug={slug}
          employerName={employerName}
          initialChoice={current}
          onDone={close}
          onCancel={canCancel ? close : null}
        />
      )}
    </ElectionCard>
  );
}
