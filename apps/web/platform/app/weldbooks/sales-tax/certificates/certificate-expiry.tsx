import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useSetupTexts } from '../setup/setup-texts';
import { expiryTone, type ExpiryTone } from './certificate-model';

const TONE_CLASS: Record<ExpiryTone, string> = {
  none: 'text-muted-foreground',
  ok: '',
  soon: 'text-amber-600 dark:text-amber-400',
  expired: 'text-destructive',
};

/** When a certificate ends, in words: "Expires Dec 31, 2026 (in 84 days)", "Expired …", or "Does not expire". */
export function CertificateExpiry({ certificate }: Readonly<{ certificate: ExemptionCertificate }>) {
  const { t, plural } = useSetupTexts();
  const te = t.certificates.expiry;
  const { formatDate } = useWeldbooksFormat();
  const tone = expiryTone(certificate);

  if (tone === 'none' || certificate.effectiveExpiresOn === null) {
    return <span className={TONE_CLASS.none}>{te.none}</span>;
  }

  const date = formatDate(certificate.effectiveExpiresOn);
  const days = certificate.daysUntilExpiry ?? 0;
  const when = days === 0 ? te.today : plural(days, te.inDays);
  return (
    <span className={TONE_CLASS[tone]}>
      {tone === 'expired' ? te.expiredOn.replace('{date}', date) : te.expiresOn.replace('{date}', date)}
      {tone !== 'expired' ? <span className="text-muted-foreground"> ({when})</span> : null}
    </span>
  );
}
