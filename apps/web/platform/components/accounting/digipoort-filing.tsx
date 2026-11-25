/**
 * What a Digipoort delivery looks like on a WeldBooks screen: the badge of a
 * delivery made in the test environment, the notice of a rejection, and the
 * answer of a status check with the messages Digipoort reported. Shared by the
 * BTW-aangifte, the Opgaaf ICP and the KvK annual report.
 */

import { FlaskConical } from 'lucide-react';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import { isPreprodDelivery, type FilingStatus } from '@/lib/weldbooks/annual-report-model';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { StatusChip, type ChipTone } from '@/components/accounting/weldbooks-row-cells';

/** "Test environment (pre-production)": shown only on a delivery made in preprod. */
export function PreprodBadge({ row }: Readonly<{ row: { digipoortResponse?: unknown } | null | undefined }>) {
  const { t } = useI18n();
  if (!isPreprodDelivery(row)) return null;
  const td = t.weldbooksNl.digipoort;
  return (
    <SoftBadge tone="warning" title={td.preprodHint} data-testid="preprod-badge">
      <FlaskConical aria-hidden="true" className="size-3" />
      {td.preprodBadge}
    </SoftBadge>
  );
}

/** Why the authority refused a delivery, with a hint that it can be filed again. */
export function RejectionNotice({
  title,
  reason,
  noReason,
  fileAgain,
}: Readonly<{ title: string; reason: string | null | undefined; noReason: string; fileAgain: string }>) {
  return (
    <InfoBanner variant="danger" title={title} data-testid="rejection-notice">
      <p className="whitespace-pre-wrap">{reason?.trim() || noReason}</p>
      <p className="mt-1 opacity-80">{fileAgain}</p>
    </InfoBanner>
  );
}

const STATUS_TONES: Record<FilingStatus['status'], ChipTone> = {
  submitted: 'blue',
  processing: 'blue',
  accepted: 'green',
  rejected: 'red',
  unknown: 'gray',
};

/** The answer of a status check: the status, what the authority said and the messages Digipoort reported. */
export function FilingStatusSummary({ status }: Readonly<{ status: FilingStatus }>) {
  const { t } = useI18n();
  const { formatDateTime } = useWeldbooksFormat();
  const td = t.weldbooksNl.digipoort;
  const entries = status.statuses ?? [];
  const detail = status.statusDescription || status.error || null;

  return (
    <section aria-labelledby="filing-status-title" className="space-y-2 rounded-md border p-3" data-testid="filing-status">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="filing-status-title" className="text-sm font-medium">
          {td.latestStatus}
        </h3>
        <StatusChip tone={STATUS_TONES[status.status]}>{td.statusLabels[status.status]}</StatusChip>
      </div>
      {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      {status.reason ? <p className="text-sm text-destructive">{status.reason}</p> : null}
      {entries.length > 0 ? (
        <>
          <h4 className="text-xs font-medium text-muted-foreground">{td.statusesTitle}</h4>
          <ol className="space-y-2">
            {entries.map((entry, index) => (
              <li key={`${entry.code ?? 'status'}-${entry.at ?? index}`} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {entry.at ? <time dateTime={entry.at} className="tabular-nums text-muted-foreground">{formatDateTime(entry.at)}</time> : null}
                  {entry.description ? <span>{entry.description}</span> : null}
                </div>
                {entry.errorCode || entry.errorDescription ? (
                  <p className="text-destructive">
                    {[entry.errorCode ? td.errorCode.replace('{code}', entry.errorCode) : null, entry.errorDescription]
                      .filter(Boolean)
                      .join(': ')}
                  </p>
                ) : null}
                {entry.details ? <p className="text-xs text-muted-foreground">{entry.details}</p> : null}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{td.statusNoMessages}</p>
      )}
    </section>
  );
}
