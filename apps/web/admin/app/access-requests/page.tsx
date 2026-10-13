import Link from 'next/link';
import { Search, ShieldCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { AccessStatusBadge } from '@/components/app-access/status-badge';
import { requireAdmin } from '@/lib/auth';
import {
  ACCESS_STATUSES,
  STATUS_LABELS,
  isAccessStatus,
  isConsentCountry,
  listSourceLabel,
  type AppAccessStatus,
} from '@/lib/app-access';
import { countAccessRequestsByStatus, listAccessRequests } from '@/lib/app-access-data';
import { formatDateTime } from '@/lib/billing-format';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type SearchParams = { status?: string; q?: string };

function href(status: string, q: string): string {
  const params = new URLSearchParams();
  if (status !== 'requested') params.set('status', status);
  if (q) params.set('q', q);
  const qs = params.toString();
  return qs ? `/access-requests?${qs}` : '/access-requests';
}

/** `requested` is the queue; `all` lifts the filter. */
function selectedStatus(status: string | undefined): AppAccessStatus | 'all' {
  if (status === 'all') return 'all';
  return isAccessStatus(status) ? status : 'requested';
}

export default async function AccessRequestsPage(props: Readonly<{
  searchParams?: Promise<SearchParams>;
}>) {
  await requireAdmin();
  const searchParams = (await props.searchParams) ?? {};
  const q = (searchParams.q ?? '').trim();
  const selected = selectedStatus(searchParams.status);

  const [rows, counts] = await Promise.all([
    listAccessRequests({ status: selected === 'all' ? undefined : selected, search: q }),
    countAccessRequestsByStatus(),
  ]);
  const total = ACCESS_STATUSES.reduce((sum, status) => sum + counts[status], 0);

  const tabs = [
    ...ACCESS_STATUSES.map((status) => ({ key: status as string, label: STATUS_LABELS[status], count: counts[status] })),
    { key: 'all', label: 'All', count: total },
  ];

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-6 w-6 text-primary" />
              Access requests
            </span>
          }
          description="Workspaces that asked for an app that is on request only. Open one to read the answers, then approve, reject or set limits."
        />

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Filter by status" className="flex flex-wrap items-center gap-1">
              {tabs.map((tab) => (
                <Link
                  key={tab.key}
                  href={href(tab.key, q)}
                  aria-current={selected === tab.key ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted',
                    selected === tab.key && 'bg-muted font-medium text-foreground',
                  )}
                >
                  {tab.label}
                  <span className="ml-1.5 tabular-nums">{tab.count}</span>
                </Link>
              ))}
            </nav>

            <form method="get" action="/access-requests" className="flex items-center gap-2">
              {selected !== 'requested' && <input type="hidden" name="status" value={selected} />}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  aria-label="Search access requests"
                  defaultValue={q}
                  placeholder="Workspace, company or email…"
                  className="h-8 w-64 pl-9"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" className="h-8">
                Search
              </Button>
            </form>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">Workspace</TableHead>
                  <TableHead className="w-28 text-[13.5px]">App</TableHead>
                  <TableHead className="w-28 text-[13.5px]">Status</TableHead>
                  <TableHead className="w-44 text-[13.5px]">Requested</TableHead>
                  <TableHead className="w-44 text-[13.5px]">Countries</TableHead>
                  <TableHead className="w-36 text-[13.5px]">List source</TableHead>
                  <TableHead className="w-24 text-right text-[13.5px]">Per day</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                      {selected === 'requested' && !q
                        ? 'No requests waiting for review.'
                        : 'No access requests match.'}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id} className="h-12 hover:bg-muted/50">
                    <TableCell className="py-2">
                      <Link href={`/access-requests/${row.id}`} className="block min-w-0">
                        <div className="truncate text-sm font-medium underline-offset-2 hover:underline">
                          {row.companyName ?? row.workspaceName}
                        </div>
                        {row.companyName && (
                          <div className="truncate text-xs text-muted-foreground">{row.workspaceName}</div>
                        )}
                      </Link>
                    </TableCell>
                    <TableCell className="py-2 text-xs">{row.appName}</TableCell>
                    <TableCell className="py-2">
                      <AccessStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">
                      {row.requestedAt ? formatDateTime(row.requestedAt) : '—'}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      {row.targetCountries.length === 0 ? (
                        '—'
                      ) : (
                        <span className="flex flex-wrap gap-x-1.5">
                          {row.targetCountries.slice(0, 6).map((code) => (
                            <span
                              key={code}
                              className={isConsentCountry(code) ? 'font-medium text-amber-600 dark:text-amber-400' : undefined}
                            >
                              {code}
                            </span>
                          ))}
                          {row.targetCountries.length > 6 && (
                            <span className="text-muted-foreground">+{row.targetCountries.length - 6}</span>
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      <span className={row.listSource === 'bought_list' ? 'text-amber-600 dark:text-amber-400' : undefined}>
                        {row.listSource ? listSourceLabel(row.listSource) : '—'}
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-right text-xs tabular-nums">
                      {row.expectedDailySends === null ? '—' : row.expectedDailySends.toLocaleString('en-GB')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>
    </PageContent>
  );
}
