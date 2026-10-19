import { useNavigate } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useSetupTexts } from '../setup/setup-texts';
import { CertificateStatusBadge } from '../setup/status-badges';
import { CertificateExpiry } from './certificate-expiry';

/** How many state chips fit in a row before the rest collapse into "+N". */
const MAX_STATE_CHIPS = 4;

export interface CertificatesListProps {
  certificates: readonly ExemptionCertificate[];
}

function CertificateRow({ certificate }: Readonly<{ certificate: ExemptionCertificate }>) {
  const { t } = useSetupTexts();
  const tc = t.certificates;
  const navigate = useNavigate();
  const { formatDate } = useWeldbooksFormat();

  const shown = certificate.states.slice(0, MAX_STATE_CHIPS);
  const more = certificate.states.length - shown.length;
  const reason = tc.reasons[certificate.reason] ?? certificate.reason;
  const number = certificate.certificateNumber ?? t.common.none;

  return (
    <TabListRow
      label={certificate.certificateNumber ?? reason}
      onOpen={() => void navigate({ to: '/weldbooks/sales-tax/certificates/$id', params: { id: certificate.id } })}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          {shown.map((code) => (
            <Badge key={code} variant="outline">
              {code}
            </Badge>
          ))}
          {more > 0 ? <Badge variant="secondary">+{more}</Badge> : null}
          <span className="ml-1 truncate text-sm">
            {reason}
            {!certificate.blanket ? <span className="text-muted-foreground"> · {tc.coverage.single}</span> : null}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>
            {tc.columns.number}: {number}
          </span>
          <CertificateExpiry certificate={certificate} />
          {/* The side panel is narrow: "last used" is a wide-layout extra. */}
          <span className="@max-[520px]:hidden">
            {tc.columns.lastUsed}:{' '}
            <span className="tabular-nums text-foreground">
              {certificate.lastUsedOn ? formatDate(certificate.lastUsedOn) : tc.expiry.neverUsed}
            </span>
          </span>
        </div>
      </div>
      <div className="flex-shrink-0">
        <CertificateStatusBadge status={certificate.status} />
      </div>
    </TabListRow>
  );
}

/**
 * A customer's exemption certificates as list rows: states, reason, number,
 * expiry and status. Rows open the certificate. Laid out as rows rather than a
 * table so it fits the 480px contact panel it lives in.
 */
export function CertificatesList({ certificates }: Readonly<CertificatesListProps>) {
  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border">
        {certificates.map((certificate) => (
          <CertificateRow key={certificate.id} certificate={certificate} />
        ))}
      </div>
    </TabListScope>
  );
}
