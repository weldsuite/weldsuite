/**
 * WeldDesk approvals: the service request steps waiting for a decision, the
 * caller's own, or everyone's for someone who manages the catalogue. Each row
 * opens the conversation, where the details panel has Approve / Reject.
 */

import { useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { ChevronRight, ClipboardCheck } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { useDeskPendingApprovals, type DeskApprovalScope } from '@/hooks/queries/use-desk-catalog-queries';

export function ApprovalsPage() {
  const t = getTranslations('deskCatalog').approvals;
  const canSeeAll = useCan('welddesk:settings:update');
  const [scope, setScope] = useState<DeskApprovalScope>('mine');
  const effective: DeskApprovalScope = canSeeAll ? scope : 'mine';
  const { data: rows, isLoading, isError, refetch } = useDeskPendingApprovals(effective);
  const { data: members = [] } = useDeskWorkspaceMembers();
  const nameOf = (userId: string | null) => (userId ? (members.find((m) => m.userId === userId)?.name ?? userId) : null);

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = <ErrorState message={t.loadError} onRetry={() => void refetch()} />;
  } else if (!rows || rows.length === 0) {
    const empty = effective === 'mine' ? t.emptyMine : t.emptyAll;
    body = <EmptyState icon={ClipboardCheck} title={empty.title} description={empty.description} />;
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="approvals-list">
        {rows.map((row) => {
          const approver = nameOf(row.approverId);
          return (
            <li key={row.approvalId}>
              <Link
                href={`/welddesk/inbox/${row.conversationId}`}
                className="flex items-center gap-3 p-4 transition-colors hover:bg-muted/50"
                aria-label={t.open.replace('{number}', String(row.conversationNumber))}
                data-testid="approval-row"
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate font-medium">{row.catalogItemName ?? t.itemRemoved}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    #{row.conversationNumber}
                    {row.title ? ` · ${row.title}` : ''}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t.requestedBy.replace('{name}', row.requesterName ?? t.unknownRequester)}
                    {row.stepName ? ` · ${t.step.replace('{name}', row.stepName)}` : ''}
                    {effective === 'all' ? ` · ${approver ? t.approverLabel.replace('{name}', approver) : t.noApprover}` : ''}
                    {` · ${t.waitingSince.replace('{time}', formatDistanceToNowStrict(new Date(row.requestedAt)))}`}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6" data-testid="approvals-page">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          {canSeeAll && (
            <div className="flex gap-1" role="group" aria-label={t.scopeLabel}>
              <Button
                size="sm"
                variant={scope === 'mine' ? 'default' : 'outline'}
                aria-pressed={scope === 'mine'}
                onClick={() => setScope('mine')}
                data-testid="approvals-scope-mine"
              >
                {t.scopeMine}
              </Button>
              <Button
                size="sm"
                variant={scope === 'all' ? 'default' : 'outline'}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
                data-testid="approvals-scope-all"
              >
                {t.scopeAll}
              </Button>
            </div>
          )}
        </div>
        {body}
      </div>
    </div>
  );
}
