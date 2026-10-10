/** Masked identity and bank details, shared by the employee Payroll tab (HR) and My HR (the employee). */

import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollCountry, HrPayrollPaymentDetailsMasked } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { formatDate } from '../../components/shared';
import { ValueRow } from './payroll-ui';

export function PaymentDetailsView({ country, details }: Readonly<{ country: HrPayrollCountry; details: HrPayrollPaymentDetailsMasked }>) {
  const t = useTranslations();
  const isNl = country === 'NL';
  const address = details.homeAddress;
  const addressLines = address
    ? [
        [address.line1, address.houseNumber, address.houseNumberAddition].filter(Boolean).join(' '),
        address.line2,
        [address.postalCode, address.city, address.region].filter(Boolean).join(' '),
      ].filter(Boolean)
    : [];

  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      <ValueRow label={isNl ? t('weldhr.payroll.details.bsn') : t('weldhr.payroll.details.ssn')}>
        {details.nationalIdMasked && <span className="font-mono">{details.nationalIdMasked}</span>}
      </ValueRow>
      <ValueRow label={t('weldhr.payroll.details.dateOfBirth')}>{details.dateOfBirth ? formatDate(details.dateOfBirth) : null}</ValueRow>
      <ValueRow label={t('weldhr.payroll.details.accountHolder')}>{details.bankAccountHolder}</ValueRow>
      {isNl ? (
        <ValueRow label="IBAN">
          {details.bankIbanMasked && (
            <span>
              <span className="font-mono">{details.bankIbanMasked}</span>
              {details.bankBic && <span className="ml-2 text-muted-foreground">{details.bankBic}</span>}
            </span>
          )}
        </ValueRow>
      ) : (
        <ValueRow label={t('weldhr.payroll.details.accountNumber')}>
          {details.bankAccountNumberMasked && (
            <span>
              <span className="font-mono">{details.bankAccountNumberMasked}</span>
              {details.bankRoutingNumber && <span className="ml-2 text-muted-foreground">{t('weldhr.payroll.details.routingShort', { routing: details.bankRoutingNumber })}</span>}
              {details.bankAccountType && <span className="ml-2 text-muted-foreground">{t(`weldhr.payroll.details.${details.bankAccountType}`)}</span>}
            </span>
          )}
        </ValueRow>
      )}
      <ValueRow label={t('weldhr.payroll.details.sections.address')}>
        {addressLines.length > 0 && (
          <span className="block">
            {addressLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        )}
      </ValueRow>
      <ValueRow label={t('weldhr.payroll.details.sections.idDocument')}>
        {details.idDocumentType && (
          <span>
            {t(`weldhr.payroll.details.idTypes.${details.idDocumentType}`)}
            {details.idDocumentExpiresOn && <span className="text-muted-foreground"> · {t('weldhr.payroll.details.expires', { date: formatDate(details.idDocumentExpiresOn) })}</span>}
            <span className="block text-xs text-muted-foreground">
              {details.idVerifiedAt ? t('weldhr.payroll.details.verifiedOn', { date: formatDate(details.idVerifiedAt) }) : t('weldhr.payroll.details.notVerified')}
            </span>
          </span>
        )}
      </ValueRow>
    </div>
  );
}
