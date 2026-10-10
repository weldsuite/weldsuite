'use client';

import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatDate } from '@/lib/date';
import type { HrTaxElection } from '@/lib/payroll/types';
import { Button, Card, Input, Label } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';

/** A labelled native checkbox with an optional explanation underneath. */
export function Checkbox({
  id,
  checked,
  onChange,
  label,
  hint,
}: Readonly<{
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}>) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-gray-300"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-gray-700">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-gray-500">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

/** The typed-name signature and the submit button that ends every tax form. */
export function SignatureBlock({
  id,
  name,
  onNameChange,
  submitting,
  error,
  statement,
}: Readonly<{
  id: string;
  name: string;
  onNameChange: (name: string) => void;
  submitting: boolean;
  error: string | null;
  /** Legal wording shown above the signature (the W-4's penalties-of-perjury line). */
  statement?: string;
}>) {
  const { dict } = useI18n();
  const t = dict.payroll.taxForms;
  return (
    <div className="space-y-3 rounded-md bg-gray-50 p-3 sm:p-4">
      {statement && <p className="text-xs text-gray-600">{statement}</p>}
      <div>
        <Label htmlFor={id}>{t.signatureLabel}</Label>
        <Input
          id={id}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          autoComplete="name"
          maxLength={255}
          required
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">
          {t.signatureHint}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <Button type="submit" disabled={submitting}>
        {submitting ? t.signing : t.sign}
      </Button>
    </div>
  );
}

/**
 * One tax form as a card: what it is, whether it is signed, and the form
 * itself. A signed form shows a summary and an "Update" button; an unsigned
 * one opens straight on the form.
 */
export function ElectionCard({
  title,
  intro,
  election,
  summary,
  children,
}: Readonly<{
  title: string;
  intro?: string;
  election: HrTaxElection | null;
  /** What the signed election says, in a sentence. */
  summary: ReactNode;
  children: (control: { close: () => void; canCancel: boolean }) => ReactNode;
}>) {
  const { dict, locale, timeZone, format } = useI18n();
  const t = dict.payroll.taxForms;
  const [editing, setEditing] = useState(election === null);
  const signed = election !== null;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-medium text-gray-900">{title}</h3>
        {election ? (
          <Badge tone="positive">
            {format(t.signedOn, { date: formatDate(election.signedAt ?? election.createdAt, locale, timeZone) })}
          </Badge>
        ) : (
          <Badge tone="warning">{t.needsSignature}</Badge>
        )}
      </div>
      {intro && <p className="mt-1 text-sm text-gray-600">{intro}</p>}

      {election && !editing && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-gray-700">
            <div>{summary}</div>
            <p className="text-xs text-gray-500">{format(t.appliesFrom, { date: formatDate(election.effectiveFrom, locale, timeZone) })}</p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm text-gray-600 underline underline-offset-2"
          >
            {t.update}
          </button>
        </div>
      )}

      {editing && <div className="mt-4">{children({ close: () => setEditing(false), canCancel: signed })}</div>}
    </Card>
  );
}
