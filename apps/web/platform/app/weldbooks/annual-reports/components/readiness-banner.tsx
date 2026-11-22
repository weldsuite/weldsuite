import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { RejectionNotice } from '@/components/accounting/digipoort-filing';
import { useI18n } from '@/lib/i18n/provider';
import { isAnnualReportEditable, type AnnualReport } from '@/lib/weldbooks/annual-report-model';

/**
 * What stands between this report and filing: the server's `issues`, or "ready".
 * A rejected report shows the KvK's reason first. A locked report needs neither.
 */
export function ReadinessBanner({ report }: Readonly<{ report: AnnualReport }>) {
  const { t } = useI18n();
  const tr = t.weldbooksNl.annualReports.readiness;
  const td = t.weldbooksNl.annualReports.detail;
  return (
    <div className="space-y-3">
      {report.status === 'rejected' ? (
        <RejectionNotice
          title={tr.rejectedTitle}
          reason={report.rejectionReason}
          noReason={tr.rejectedNoReason}
          fileAgain={tr.rejectedFileAgain}
        />
      ) : null}
      {report.status === 'submitted' ? <InfoBanner variant="info">{td.submittedNotice}</InfoBanner> : null}
      {!isAnnualReportEditable(report.status) && report.status !== 'submitted' ? (
        <InfoBanner variant="neutral">{td.locked}</InfoBanner>
      ) : null}
      {isAnnualReportEditable(report.status) ? (
        report.issues.length > 0 ? (
          <InfoBanner variant="warning" title={tr.issuesTitle} data-testid="readiness-issues">
            <p>{tr.issuesIntro}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {report.issues.map((issue) => (
                <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </InfoBanner>
        ) : (
          <InfoBanner variant="success" title={tr.readyTitle} data-testid="readiness-ready">
            {tr.readyBody}
          </InfoBanner>
        )
      ) : null}
    </div>
  );
}
