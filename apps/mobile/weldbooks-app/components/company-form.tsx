/**
 * The company's tax IDs, bank details and address: the fields an invoice can't
 * be finalised without. Shared by the first-company setup and the edit sheet, so
 * both ask for the same things in the same words.
 *
 * The parent keeps the draft and the problems; this only draws the fields. A
 * field the jurisdiction makes mandatory for invoices says so underneath, since
 * the company can still be saved without it (a fresh company has none of them
 * yet) but the first invoice can't be finalised.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Input } from '@weldsuite/mobile-ui/components/Input';

import { AddressFields, type AddressErrors } from '@/components/address-fields';
import { formatCnpjInput } from '@/lib/br';
import { formatIbanInput, type InvoiceField } from '@/lib/company';
import { companyProblemText, type CompanyDraft, type CompanyProblems } from '@/lib/company-form';
import { useI18n } from '@/lib/i18n';
import type { TerminologyLabels } from '@/lib/jurisdiction';
import { formatEinInput } from '@/lib/us';
import type { JurisdictionTerminology } from '@/types/accounting';

/** The line under the tax ID field: how to write an EIN or a CNPJ, or that invoices need it. */
function taxIdHelper(
  code: string,
  required: boolean,
  error: string | undefined,
  texts: { einHint: string; cnpjHint: string; needed: string },
): string | undefined {
  if (error) return undefined;
  if (code === 'US') return texts.einHint;
  if (code === 'BR') return texts.cnpjHint;
  return required ? texts.needed : undefined;
}

export function CompanyFields({
  code,
  draft,
  onChange,
  problems,
  usAddressErrors,
  requiredFields,
  labels,
  terminology,
  taxIdLabel,
}: Readonly<{
  /** The company's jurisdiction code (`NL`, `US`, ...). */
  code: string;
  draft: CompanyDraft;
  onChange: (next: CompanyDraft) => void;
  problems: CompanyProblems;
  usAddressErrors?: AddressErrors;
  /** What the jurisdiction needs on an invoice: those fields carry the "needed to finalise" line. */
  requiredFields: readonly InvoiceField[];
  labels: Pick<TerminologyLabels, 'taxIdPlaceholder' | 'registrationId'>;
  terminology: JurisdictionTerminology;
  taxIdLabel: string;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const isUs = code === 'US';
  const isBr = code === 'BR';
  const needs = (field: InvoiceField) => requiredFields.includes(field);
  const set = (patch: Partial<CompanyDraft>) => onChange({ ...draft, ...patch });

  const taxIdError = problems.taxId ? companyProblemText(problems.taxId, t) : undefined;
  const registrationError = problems.registrationNumber
    ? companyProblemText(problems.registrationNumber, t)
    : undefined;
  const ibanError = problems.iban ? companyProblemText(problems.iban, t) : undefined;
  const registrationPlaceholder =
    (t.company.registrationPlaceholder as Record<string, string>)[terminology.registrationId] ?? '';

  return (
    <>
      <Input
        label={taxIdLabel}
        value={draft.taxId}
        onChangeText={(text) => {
          if (isUs) set({ taxId: formatEinInput(text) });
          else set({ taxId: isBr ? formatCnpjInput(text) : text });
        }}
        placeholder={labels.taxIdPlaceholder}
        helperText={taxIdHelper(code, needs('vatNumber'), taxIdError, {
          einHint: t.entitySetup.einHint,
          cnpjHint: t.entitySetup.cnpjHint,
          needed: t.company.neededForInvoices,
        })}
        error={taxIdError}
        keyboardType={isUs ? 'number-pad' : 'default'}
        autoCapitalize="characters"
        autoCorrect={false}
      />

      {needs('registrationNumber') ? (
        <Input
          label={labels.registrationId}
          value={draft.registrationNumber}
          onChangeText={(registrationNumber) => set({ registrationNumber })}
          placeholder={registrationPlaceholder}
          helperText={registrationError ? undefined : t.company.neededForInvoices}
          error={registrationError}
          autoCapitalize="characters"
          autoCorrect={false}
        />
      ) : null}

      {needs('iban') ? (
        <>
          <Input
            label={t.company.iban}
            value={draft.iban}
            onChangeText={(iban) => set({ iban: formatIbanInput(iban) })}
            placeholder={t.company.ibanPlaceholder}
            helperText={ibanError ? undefined : t.company.neededForInvoices}
            error={ibanError}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Input
            label={t.company.bic}
            value={draft.bic}
            onChangeText={(bic) => set({ bic: bic.toUpperCase() })}
            placeholder={t.company.bicPlaceholder}
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </>
      ) : null}

      <View style={styles.group}>
        <Text style={[styles.groupTitle, { color: colors.text }]}>{t.entitySetup.businessAddress}</Text>
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>
          {isUs ? t.entitySetup.addressHint : t.entitySetup.addressHintInvoice}
          {!isUs && needs('address') ? ` ${t.company.neededForInvoices}.` : ''}
        </Text>
        {isUs ? (
          <AddressFields
            value={draft.address}
            onChange={(address) => set({ address })}
            errors={usAddressErrors}
          />
        ) : (
          <View style={styles.fields}>
            <Input
              label={t.address.line1}
              value={draft.address.line1}
              onChangeText={(line1) => set({ address: { ...draft.address, line1 } })}
              placeholder={t.address.line1Placeholder}
              error={problems.address?.line1 ? t.company.line1Required : undefined}
              autoCapitalize="words"
              autoComplete="address-line1"
            />
            <View style={styles.row}>
              <Input
                label={t.company.postalCode}
                value={draft.address.postalCode}
                onChangeText={(postalCode) => set({ address: { ...draft.address, postalCode } })}
                placeholder={t.company.postalCodePlaceholder}
                containerStyle={styles.postal}
                autoCapitalize="characters"
                autoComplete="postal-code"
              />
              <Input
                label={t.address.city}
                value={draft.address.city}
                onChangeText={(city) => set({ address: { ...draft.address, city } })}
                error={problems.address?.city ? t.company.cityRequired : undefined}
                containerStyle={styles.city}
                autoCapitalize="words"
              />
            </View>
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  groupTitle: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17 },
  fields: { gap: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  postal: { flex: 1 },
  city: { flex: 1.6 },
});
