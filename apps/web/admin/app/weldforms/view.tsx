import Link from '@/components/link';
import { FileText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { TableCell, TableRow } from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { FilterTabs } from '@/components/outbound-mail/parts';
import { ModerationActions } from '@/components/weldforms/actions';
import { EmptyRow, Section, TableFrame, Th } from '@/components/warmup/parts';
import { formatDateTime } from '@/lib/billing-format';
import {
  REPORT_STATUSES,
  REPORT_STATUS_LABELS,
  formState,
  reasonLabel,
  weldformsHref,
  type FormState,
  type ReportStatus,
} from '@/lib/weldforms';
import type { FormLinkRow, ReportRow } from '@/lib/weldforms-data';
import type { WeldFormsPageData } from './data';

const STATE_VARIANT: Record<FormState, 'destructive' | 'warning' | 'secondary'> = {
  suspended: 'destructive',
  held: 'warning',
  live: 'secondary',
};
const STATE_LABEL: Record<FormState, string> = { suspended: 'Suspended', held: 'Held', live: 'Live' };

const REPORT_VARIANT: Record<ReportStatus, 'outline' | 'secondary' | 'destructive'> = {
  open: 'outline',
  dismissed: 'secondary',
  actioned: 'destructive',
};

function WorkspaceCell({ id, name }: Readonly<{ id: string; name: string | null }>) {
  return (
    <div className="min-w-0">
      <Link href={`/workspaces/${id}`} className="font-medium hover:underline">
        {name ?? 'Unknown workspace'}
      </Link>
      <div className="font-mono text-xs text-muted-foreground">{id}</div>
    </div>
  );
}

function PublicLink({ url, publicId }: Readonly<{ url: string; publicId: string }>) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="break-all font-mono text-xs hover:underline">
      {publicId}
    </a>
  );
}

function ReportTable({ rows, canWrite }: Readonly<{ rows: ReportRow[]; canWrite: boolean }>) {
  return (
    <TableFrame
      head={
        <>
          <Th>Form</Th>
          <Th>Workspace</Th>
          <Th>Report</Th>
          <Th>Reported</Th>
          <Th>State</Th>
          {canWrite && <Th right>Actions</Th>}
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyRow colSpan={canWrite ? 6 : 5}>No reports.</EmptyRow>
      ) : (
        rows.map((row) => {
          const state = formState(row);
          return (
            <TableRow key={row.id} className="align-top">
              <TableCell>
                <PublicLink url={row.publicUrl} publicId={row.publicId} />
                <div className="break-all text-xs text-muted-foreground">{row.publicUrl}</div>
              </TableCell>
              <TableCell>
                <WorkspaceCell id={row.workspaceId} name={row.workspaceName} />
              </TableCell>
              <TableCell className="max-w-md space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{reasonLabel(row.reason)}</Badge>
                  <Badge variant={REPORT_VARIANT[row.status]}>{REPORT_STATUS_LABELS[row.status]}</Badge>
                </div>
                {row.details && <p className="whitespace-pre-wrap break-words text-sm">{row.details}</p>}
                <p className="text-xs text-muted-foreground">
                  Reporter: {row.reporterEmail ?? 'anonymous'}
                  {row.resolvedAt && ` · ${REPORT_STATUS_LABELS[row.status].toLowerCase()} by ${row.resolvedBy ?? 'staff'}, ${formatDateTime(row.resolvedAt)}`}
                </p>
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm">{formatDateTime(row.createdAt)}</TableCell>
              <TableCell>
                {row.linkExists ? (
                  <Badge variant={STATE_VARIANT[state]}>{STATE_LABEL[state]}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">Link removed</span>
                )}
              </TableCell>
              {canWrite && (
                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <ModerationActions
                      canWrite={canWrite}
                      publicId={row.publicId}
                      workspaceId={row.workspaceId}
                      workspaceName={row.workspaceName}
                      suspended={state === 'suspended'}
                      held={state === 'held'}
                      linkExists={row.linkExists}
                      reportId={row.id}
                      reportOpen={row.status === 'open'}
                    />
                  </div>
                </TableCell>
              )}
            </TableRow>
          );
        })
      )}
    </TableFrame>
  );
}

function FormTable({
  rows,
  canWrite,
  kind,
}: Readonly<{ rows: FormLinkRow[]; canWrite: boolean; kind: 'held' | 'suspended' }>) {
  return (
    <TableFrame
      head={
        <>
          <Th>Form</Th>
          <Th>Workspace</Th>
          <Th>Reason</Th>
          <Th>{kind === 'held' ? 'Held' : 'Suspended'}</Th>
          {canWrite && <Th right>Actions</Th>}
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyRow colSpan={canWrite ? 5 : 4}>{kind === 'held' ? 'No forms are held for review.' : 'No forms are suspended.'}</EmptyRow>
      ) : (
        rows.map((row) => (
          <TableRow key={row.id} className="align-top">
            <TableCell>
              <PublicLink url={row.publicUrl} publicId={row.publicId} />
              <div className="break-all text-xs text-muted-foreground">{row.publicUrl}</div>
            </TableCell>
            <TableCell>
              <WorkspaceCell id={row.workspaceId} name={row.workspaceName} />
            </TableCell>
            <TableCell className="max-w-md whitespace-pre-wrap break-words text-sm">
              {(kind === 'held' ? row.heldReason : row.suspendedReason) ?? '—'}
            </TableCell>
            <TableCell className="whitespace-nowrap text-sm">
              {formatDateTime(kind === 'held' ? row.heldAt : row.suspendedAt)}
            </TableCell>
            {canWrite && (
              <TableCell className="text-right">
                <div className="flex justify-end">
                  <ModerationActions
                    canWrite={canWrite}
                    publicId={row.publicId}
                    workspaceId={row.workspaceId}
                    workspaceName={row.workspaceName}
                    suspended={kind === 'suspended'}
                    held={kind === 'held'}
                  />
                </div>
              </TableCell>
            )}
          </TableRow>
        ))
      )}
    </TableFrame>
  );
}

export function WeldFormsPage({
  status,
  canWrite,
  reports,
  counts,
  held,
  suspended,
  reportListLimit,
  formListLimit,
}: Readonly<WeldFormsPageData>) {
  const total = REPORT_STATUSES.reduce((sum, s) => sum + counts[s], 0);
  return (
    <PageContent>
      <PageBody className="space-y-8">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <FileText className="h-6 w-6 text-primary" />
              WeldForms
            </span>
          }
          description="Abuse reports on public forms, forms the publish content screen held for review, and the forms staff suspended. A suspension or release takes effect on the next respondent request."
        />

        <Section
          title="Held for review"
          note={held.length >= formListLimit ? `Showing the newest ${formListLimit}.` : 'Held by the publish content screen. Release a form once it looks fine.'}
        >
          <FormTable rows={held} canWrite={canWrite} kind="held" />
        </Section>

        <Section
          title="Abuse reports"
          note={reports.length >= reportListLimit ? `Showing the newest ${reportListLimit}. Filter to narrow it down.` : 'Newest first.'}
        >
          <FilterTabs
            label="Status"
            selected={status}
            tabs={[
              ...REPORT_STATUSES.map((s) => ({
                key: s,
                label: REPORT_STATUS_LABELS[s],
                count: counts[s],
                href: weldformsHref(s),
              })),
              { key: 'all', label: 'All', count: total, href: weldformsHref('all') },
            ]}
          />
          <ReportTable rows={reports} canWrite={canWrite} />
        </Section>

        <Section
          title="Suspended forms"
          note={suspended.length >= formListLimit ? `Showing the most recent ${formListLimit}.` : 'Respondents see "no longer available".'}
        >
          <FormTable rows={suspended} canWrite={canWrite} kind="suspended" />
        </Section>
      </PageBody>
    </PageContent>
  );
}
