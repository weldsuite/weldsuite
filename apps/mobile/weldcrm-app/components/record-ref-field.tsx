/**
 * A form field that points at one company or one person, the way a task, a
 * note or an activity does on the web ("Select record"). Tapping it asks which
 * kind, then opens that picker.
 */

import React, { useState } from 'react';
import { CompanyPicker, PersonPicker } from '@/components/company-picker';
import { OptionSheet, SelectField } from '@/components/option-sheet';
import type { RecordKind, RecordRef } from '@/services/notes';
import { useI18n } from '@/lib/i18n';

interface RecordRefFieldProps {
  label: string;
  value?: RecordRef;
  onChange: (record: RecordRef | undefined) => void;
  required?: boolean;
  error?: string | null;
  disabled?: boolean;
  /** Only offer one kind (skips the kind question). */
  kinds?: readonly RecordKind[];
}

export function RecordRefField({
  label,
  value,
  onChange,
  required,
  error,
  disabled,
  kinds = ['company', 'person'],
}: Readonly<RecordRefFieldProps>) {
  const { t } = useI18n();
  const [step, setStep] = useState<'closed' | 'kind' | RecordKind>('closed');

  const open = () => setStep(kinds.length === 1 ? kinds[0] : 'kind');
  const kindLabel = (kind: RecordKind) => (kind === 'company' ? t.records.company : t.records.person);
  const select = (record: RecordRef) => {
    onChange(record);
    setStep('closed');
  };

  return (
    <>
      <SelectField
        label={label}
        value={value ? `${value.name || t.common.unknown} · ${kindLabel(value.kind)}` : null}
        placeholder={t.records.selectRecord}
        required={required}
        error={error}
        disabled={disabled}
        onPress={open}
        onClear={required ? undefined : () => onChange(undefined)}
      />
      <OptionSheet<RecordKind>
        visible={step === 'kind'}
        title={t.records.selectRecord}
        options={kinds.map((kind) => ({ value: kind, label: kindLabel(kind) }))}
        onSelect={(kind) => setStep(kind ?? 'closed')}
        onClose={() => setStep('closed')}
      />
      <CompanyPicker
        visible={step === 'company'}
        onClose={() => setStep('closed')}
        onSelect={(company) => select({ kind: 'company', id: company.id, name: company.name })}
      />
      <PersonPicker
        visible={step === 'person'}
        onClose={() => setStep('closed')}
        onSelect={(person) => select({ kind: 'person', id: person.id, name: person.name })}
      />
    </>
  );
}
