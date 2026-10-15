import Link from 'next/link';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { formatDateTime } from '@/lib/billing-format';
import { cn } from '@/lib/utils';
import { CASE_STATUS_LABELS, TRIGGER_LABELS, isCaseTrigger, sourceLabel, verdictLine } from '@/lib/outbound-mail';
import type { CaseRow } from '@/lib/outbound-mail-data';
import { CaseActions } from './case-actions';
import { CaseStatusBadge, Facts, RiskScore, SeverityBadge } from './parts';

function triggerLabel(trigger: string): string {
  return isCaseTrigger(trigger) ? TRIGGER_LABELS[trigger] : trigger;
}

/** Who the case is about: a workspace (linked), a personal WeldMail account, or the platform. */
function CaseSubject({ row, linkWorkspace }: Readonly<{ row: CaseRow; linkWorkspace: boolean }>) {
  if (row.workspaceId) {
    const name = row.workspaceName ?? row.workspaceId;
    return linkWorkspace ? (
      <Link href={`/outbound-mail/${row.workspaceId}`} className="font-medium underline-offset-2 hover:underline">
        {name}
      </Link>
    ) : (
      <span className="font-medium">{name}</span>
    );
  }
  if (row.personalAccountId) return <span className="font-medium">Personal account {row.personalAccountId}</span>;
  return <span className="font-medium">Platform</span>;
}

/** One case: what tripped, the AI verdict, the numbers, and the review. */
export function CaseCard({
  row,
  canWrite,
  highlighted = false,
  linkWorkspace = true,
}: Readonly<{ row: CaseRow; canWrite: boolean; highlighted?: boolean; linkWorkspace?: boolean }>) {
  const facts: Array<{ label: string; value: React.ReactNode }> = [];
  if (row.subject) facts.push({ label: 'Subject', value: row.subject });
  if (row.sampleDomains.length > 0) {
    facts.push({ label: 'Recipient domains', value: <span className="font-mono">{row.sampleDomains.join(', ')}</span> });
  }
  if (row.sources.length > 0) facts.push({ label: 'Sent through', value: row.sources.map(sourceLabel).join(', ') });
  for (const item of row.metrics) facts.push({ label: item.label, value: <span className="tabular-nums">{item.value}</span> });
  if (row.fingerprint) facts.push({ label: 'Fingerprint', value: <span className="font-mono">{row.fingerprint}</span> });

  return (
    <Card id={`case-${row.id}`} className={cn('py-4', highlighted && 'ring-2 ring-primary/60')}>
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <SeverityBadge severity={row.severity} />
            <span className="font-medium">{triggerLabel(row.trigger)}</span>
            <span aria-hidden className="text-muted-foreground">·</span>
            <CaseSubject row={row} linkWorkspace={linkWorkspace} />
            <CaseStatusBadge status={row.status} />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {row.riskScore !== null && (
              <span>
                Risk <RiskScore score={row.riskScore} />
              </span>
            )}
            <span className="tabular-nums">{formatDateTime(row.createdAt)}</span>
          </div>
        </div>

        {row.summary && <p className="text-sm">{row.summary}</p>}

        {row.verdict && (
          <div className="space-y-1 rounded-md border px-3 py-2">
            <p className="text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">AI verdict</span>{' '}
              <span className="font-medium">{verdictLine(row.verdict)}</span>
              {row.verdict.modelId && <span className="text-xs text-muted-foreground"> · {row.verdict.modelId}</span>}
            </p>
            {row.verdict.signals.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {[...new Set(row.verdict.signals)].map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Facts items={facts} />

        {row.reviewedAt && (
          <p className="text-xs text-muted-foreground">
            {row.status === 'open' ? 'Reviewed' : CASE_STATUS_LABELS[row.status]} {formatDateTime(row.reviewedAt)}
            {row.reviewedBy ? ` by ${row.reviewedBy}` : ''}
            {row.reviewNotes ? `: “${row.reviewNotes}”` : ''}
          </p>
        )}

        <CaseActions caseId={row.id} status={row.status} hasSnippet={row.hasSnippet} canWrite={canWrite} />
      </CardContent>
    </Card>
  );
}
