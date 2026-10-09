/**
 * The identity and bank details payroll needs: BSN or SSN, date of birth, bank
 * account, home address and ID document. Used by HR on the employee's Payroll
 * tab and by the employee on My HR. Secrets are write-only: the form shows
 * only a masked value, and a blank secret keeps what is stored. Other blank
 * fields clear the stored value.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollPaymentDetailsMasked, HrPayrollCountry } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { hrPayrollPaymentDetailsSchema, type HrPayrollPaymentDetailsInput } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { ErrorBanner } from '../../components/shared';
import { SelectField, TextField } from './form-fields';
import { FormSection } from './payroll-ui';

type Values = z.input<typeof hrPayrollPaymentDetailsSchema>;
type Parsed = z.output<typeof hrPayrollPaymentDetailsSchema>;

const ID_TYPES = ['passport', 'id_card', 'residence_permit', 'drivers_license'] as const;

function blankToNull(value: string | null | undefined): string | null {
  return value && value.trim() !== '' ? value.trim() : null;
}

export function PaymentDetailsForm({
  country,
  details,
  isHr,
  saving,
  failure,
  onSubmit,
  onCancel,
}: Readonly<{
  country: HrPayrollCountry;
  details: HrPayrollPaymentDetailsMasked;
  /** HR also records when the ID document was checked. */
  isHr: boolean;
  saving: boolean;
  failure: string | null;
  onSubmit: (values: HrPayrollPaymentDetailsInput) => Promise<void>;
  onCancel: () => void;
}>) {
  const t = useTranslations();
  const isNl = country === 'NL';
  const address = details.homeAddress ?? {};

  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(hrPayrollPaymentDetailsSchema),
    defaultValues: {
      nationalId: null,
      dateOfBirth: details.dateOfBirth,
      bankAccountHolder: details.bankAccountHolder,
      bankIban: null,
      bankBic: details.bankBic,
      bankRoutingNumber: details.bankRoutingNumber,
      bankAccountNumber: null,
      bankAccountType: details.bankAccountType,
      homeAddress: {
        line1: address.line1 ?? null,
        line2: address.line2 ?? null,
        houseNumber: address.houseNumber ?? null,
        houseNumberAddition: address.houseNumberAddition ?? null,
        postalCode: address.postalCode ?? null,
        city: address.city ?? null,
        region: address.region ?? null,
        country: address.country ?? country,
      },
      idDocumentType: details.idDocumentType,
      idDocumentNumber: null,
      idDocumentExpiresOn: details.idDocumentExpiresOn,
      idVerifiedAt: details.idVerifiedAt ? details.idVerifiedAt.slice(0, 10) : null,
    },
  });

  async function submit(values: Parsed) {
    const home = values.homeAddress;
    const addressEntries = home ? Object.entries(home).filter(([key, value]) => key !== 'country' && blankToNull(value as string | null | undefined) !== null) : [];
    await onSubmit({
      // Secrets: blank keeps what is stored.
      nationalId: blankToNull(values.nationalId) ?? undefined,
      idDocumentNumber: blankToNull(values.idDocumentNumber) ?? undefined,
      ...(isNl
        ? { bankIban: blankToNull(values.bankIban) ?? undefined, bankBic: blankToNull(values.bankBic) }
        : {
            bankRoutingNumber: blankToNull(values.bankRoutingNumber),
            bankAccountNumber: blankToNull(values.bankAccountNumber) ?? undefined,
            bankAccountType: values.bankAccountType ?? null,
          }),
      dateOfBirth: blankToNull(values.dateOfBirth),
      bankAccountHolder: blankToNull(values.bankAccountHolder),
      homeAddress: addressEntries.length === 0 ? null : { ...home, country: home?.country ?? country },
      idDocumentType: values.idDocumentType ?? null,
      idDocumentExpiresOn: blankToNull(values.idDocumentExpiresOn),
      ...(isHr ? { idVerifiedAt: blankToNull(values.idVerifiedAt) } : {}),
    });
  }

  const nationalIdLabel = isNl ? t('weldhr.payroll.details.bsn') : t('weldhr.payroll.details.ssn');
  const keepHint = t('weldhr.payroll.details.keepHint');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
        <ErrorBanner error={failure} />

        <FormSection title={t('weldhr.payroll.details.sections.identity')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              control={form.control}
              name="nationalId"
              label={nationalIdLabel}
              inputMode="numeric"
              placeholder={details.nationalIdMasked ?? undefined}
              description={details.hasNationalId ? keepHint : undefined}
              maxLength={11}
            />
            <TextField control={form.control} name="dateOfBirth" label={t('weldhr.payroll.details.dateOfBirth')} type="date" />
          </div>
        </FormSection>

        <FormSection title={t('weldhr.payroll.details.sections.bank')} description={t('weldhr.payroll.details.bankHint')}>
          <TextField control={form.control} name="bankAccountHolder" label={t('weldhr.payroll.details.accountHolder')} maxLength={140} />
          {isNl ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="bankIban"
                label="IBAN"
                placeholder={details.bankIbanMasked ?? undefined}
                description={details.bankIbanMasked ? keepHint : undefined}
                maxLength={34}
              />
              <TextField control={form.control} name="bankBic" label="BIC" maxLength={11} />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField control={form.control} name="bankRoutingNumber" label={t('weldhr.payroll.details.routingNumber')} inputMode="numeric" maxLength={9} />
              <TextField
                control={form.control}
                name="bankAccountNumber"
                label={t('weldhr.payroll.details.accountNumber')}
                inputMode="numeric"
                placeholder={details.bankAccountNumberMasked ?? undefined}
                description={details.bankAccountNumberMasked ? keepHint : undefined}
                maxLength={17}
              />
              <SelectField
                control={form.control}
                name="bankAccountType"
                label={t('weldhr.payroll.details.accountType')}
                options={[
                  { value: 'checking', label: t('weldhr.payroll.details.checking') },
                  { value: 'savings', label: t('weldhr.payroll.details.savings') },
                ]}
              />
            </div>
          )}
        </FormSection>

        <FormSection title={t('weldhr.payroll.details.sections.address')}>
          {isNl ? (
            <div className="grid gap-3 sm:grid-cols-6">
              <TextField control={form.control} name="homeAddress.line1" label={t('weldhr.payroll.settings.employers.street')} className="sm:col-span-3" maxLength={255} />
              <TextField control={form.control} name="homeAddress.houseNumber" label={t('weldhr.payroll.settings.employers.houseNumber')} className="sm:col-span-1" maxLength={20} />
              <TextField control={form.control} name="homeAddress.houseNumberAddition" label={t('weldhr.payroll.settings.employers.houseNumberAddition')} className="sm:col-span-2" maxLength={20} />
              <TextField control={form.control} name="homeAddress.postalCode" label={t('weldhr.payroll.settings.employers.postalCode')} className="sm:col-span-2" maxLength={20} />
              <TextField control={form.control} name="homeAddress.city" label={t('weldhr.payroll.settings.employers.city')} className="sm:col-span-4" maxLength={120} />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-6">
              <TextField control={form.control} name="homeAddress.line1" label={t('weldhr.payroll.settings.employers.addressLine1')} className="sm:col-span-3" maxLength={255} />
              <TextField control={form.control} name="homeAddress.line2" label={t('weldhr.payroll.settings.employers.addressLine2')} className="sm:col-span-3" maxLength={255} />
              <TextField control={form.control} name="homeAddress.city" label={t('weldhr.payroll.settings.employers.city')} className="sm:col-span-3" maxLength={120} />
              <TextField control={form.control} name="homeAddress.region" label={t('weldhr.payroll.settings.employers.state')} className="sm:col-span-1" maxLength={120} />
              <TextField control={form.control} name="homeAddress.postalCode" label={t('weldhr.payroll.settings.employers.zip')} className="sm:col-span-2" maxLength={20} />
            </div>
          )}
        </FormSection>

        <FormSection title={t('weldhr.payroll.details.sections.idDocument')}>
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              control={form.control}
              name="idDocumentType"
              label={t('weldhr.payroll.details.idType')}
              emptyLabel={t('weldhr.common.none')}
              options={ID_TYPES.map((type) => ({ value: type, label: t(`weldhr.payroll.details.idTypes.${type}`) }))}
            />
            <TextField
              control={form.control}
              name="idDocumentNumber"
              label={t('weldhr.payroll.details.idNumber')}
              description={details.idDocumentType ? keepHint : undefined}
              maxLength={40}
            />
            <TextField control={form.control} name="idDocumentExpiresOn" label={t('weldhr.payroll.details.idExpires')} type="date" />
          </div>
          {isHr && (
            <TextField
              control={form.control}
              name="idVerifiedAt"
              label={t('weldhr.payroll.details.idVerifiedAt')}
              description={t('weldhr.payroll.details.idVerifiedHint')}
              type="date"
            />
          )}
        </FormSection>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.common.save')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
