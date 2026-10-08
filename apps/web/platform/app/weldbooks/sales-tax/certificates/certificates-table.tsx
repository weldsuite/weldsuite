import { useNavigate } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { CustomerName } from '../setup/customer-picker';
import { useSetupTexts } from '../setup/setup-texts';
import { CertificateStatusBadge } from '../setup/status-badges';
import { CertificateExpiry } from './certificate-expiry';

/** How many state chips fit in a row before the rest collapse into "+N". */
const MAX_STATE_CHIPS = 4;

export interface CertificatesTableProps {
  certificates: readonly ExemptionCertificate[];
  /** The customer column is left out where every row is the same customer (the customer's own tab). */
  showCustomer?: boolean;
}

/** Exemption certificates as a table: customer, states, reason, number, expiry and status. Rows open the certificate. */
export function CertificatesTable({ certificates, showCustomer = true }: Readonly<CertificatesTableProps>) {
  const { t } = useSetupTexts();
  const tc = t.certificates;
  const navigate = useNavigate();
  const { formatDate } = useWeldbooksFormat();

  const open = (id: string) => void navigate({ to: '/weldbooks/sales-tax/certificates/$id', params: { id } });

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {showCustomer ? <TableHead>{tc.columns.customer}</TableHead> : null}
            <TableHead>{tc.columns.states}</TableHead>
            <TableHead>{tc.columns.reason}</TableHead>
            <TableHead>{tc.columns.number}</TableHead>
            <TableHead>{tc.columns.expires}</TableHead>
            <TableHead>{tc.columns.status}</TableHead>
            <TableHead>{tc.columns.lastUsed}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {certificates.map((certificate) => {
            const shown = certificate.states.slice(0, MAX_STATE_CHIPS);
            const more = certificate.states.length - shown.length;
            return (
              <TableRow
                key={certificate.id}
                className="cursor-pointer"
                tabIndex={0}
                onClick={() => open(certificate.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') open(certificate.id);
                }}
              >
                {showCustomer ? (
                  <TableCell className="font-medium">
                    <CustomerName partyId={certificate.partyId} />
                  </TableCell>
                ) : null}
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {shown.map((code) => (
                      <Badge key={code} variant="outline">
                        {code}
                      </Badge>
                    ))}
                    {more > 0 ? <Badge variant="secondary">+{more}</Badge> : null}
                  </div>
                </TableCell>
                <TableCell>
                  {tc.reasons[certificate.reason] ?? certificate.reason}
                  {!certificate.blanket ? <span className="text-muted-foreground"> · {tc.coverage.single}</span> : null}
                </TableCell>
                <TableCell>{certificate.certificateNumber ?? t.common.none}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <CertificateExpiry certificate={certificate} />
                </TableCell>
                <TableCell>
                  <CertificateStatusBadge status={certificate.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {certificate.lastUsedOn ? formatDate(certificate.lastUsedOn) : tc.expiry.neverUsed}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
