import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import type { SavedReportState } from './use-saved-report';

/** Above a builder: which report is being edited, or why the one in the URL did not load. */
export function SavedReportNotices({ saved }: Readonly<{ saved: SavedReportState }>) {
  const { t } = useI18n();
  const ti = t.weldpanel.analytics.insights;
  const { report, wrongKindPath } = saved;
  return (
    <>
      {report && !wrongKindPath && <p className="text-sm text-muted-foreground">{ti.editing.replace('{name}', report.name)}</p>}
      {report && wrongKindPath && (
        <InfoBanner variant="warning">
          {ti.wrongKind.replace('{kind}', t.weldpanel.analytics.kinds[report.kind])}{' '}
          <Link href={`${wrongKindPath}?report=${encodeURIComponent(report.id)}`} className="underline underline-offset-2">
            {t.weldpanel.analytics.common.open}
          </Link>
        </InfoBanner>
      )}
      {(saved.isError || saved.invalid) && <InfoBanner variant="danger">{ti.reportFailed}</InfoBanner>}
    </>
  );
}
