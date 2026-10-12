/**
 * Territory requests: people in the partner's countries who asked for a
 * WeldSuite workspace. "Provision" opens the New workspace dialog pre-filled.
 */

import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import type { PartnerWorkspaceRequest } from '@weldsuite/app-api-client/domains/partners';
import { usePartnerRequests, useUpdatePartnerRequest } from '@/hooks/queries/use-partner-queries';
import { COUNTRIES } from '@/lib/constants/countries';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { Link, useRouter } from '@/lib/router';
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  RequestStatusBadge,
  errorText,
  useFormatters,
} from './components/kit';

type Filter = 'open' | 'all';

function countryName(code: string): string {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

export default function PartnerRequestsPage() {
  const { t } = useI18n();
  const tr = t.partner.requests;
  const { data, isLoading, error, refetch } = usePartnerRequests();
  const [filter, setFilter] = useState<Filter>('open');

  const all = data ?? [];
  const list = filter === 'open' ? all.filter((r) => r.status === 'new' || r.status === 'contacted') : all;

  const filters = (
    <div role="group" aria-label={tr.title} className="inline-flex rounded-lg border p-0.5">
      {(['open', 'all'] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          variant={filter === value ? 'secondary' : 'ghost'}
          aria-pressed={filter === value}
          onClick={() => setFilter(value)}
        >
          {value === 'open' ? tr.filterOpen : tr.filterAll}
        </Button>
      ))}
    </div>
  );

  let body;
  if (isLoading) body = <LoadingBlock />;
  else if (error) body = <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />;
  else if (list.length === 0) body = <EmptyBlock icon={Inbox} title={tr.emptyTitle} description={tr.emptyDescription} />;
  else
    body = (
      <ul className="space-y-3">
        {list.map((request) => (
          <RequestCard key={request.id} request={request} />
        ))}
      </ul>
    );

  return (
    <>
      <PageHeader title={tr.title} description={tr.description} actions={filters} />
      {body}
    </>
  );
}

function RequestCard({ request }: Readonly<{ request: PartnerWorkspaceRequest }>) {
  const { t } = useI18n();
  const tr = t.partner.requests;
  const f = useFormatters();
  const router = useRouter();
  const { can } = usePartnerContext();
  const update = useUpdatePartnerRequest();
  const canManage = can('partner:workspaces:manage');
  const open = request.status === 'new' || request.status === 'contacted';

  const setStatus = async (status: 'contacted' | 'declined') => {
    try {
      await update.mutateAsync({ requestId: request.id, body: { status } });
      toast.success(tr.updated);
    } catch (err) {
      toast.error(errorText(err, tr.updateFailed));
    }
  };

  return (
    <li>
      <Card>
        <CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{request.companyName}</p>
              <RequestStatusBadge status={request.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {request.requesterName ? `${request.requesterName} · ` : ''}
              <a className="underline underline-offset-2" href={`mailto:${request.requesterEmail}`}>
                {request.requesterEmail}
              </a>
            </p>
            <p className="text-sm text-muted-foreground">
              {countryName(request.countryCode)} · {tr.received} {f.date(request.createdAt)}
            </p>
            {request.selectedApps.length > 0 && (
              <p className="text-sm">
                <span className="text-muted-foreground">{tr.apps}: </span>
                {request.selectedApps.join(', ')}
              </p>
            )}
            {request.message && <p className="whitespace-pre-line text-sm italic text-muted-foreground">“{request.message}”</p>}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {request.status === 'provisioned' && request.workspaceId && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/partner/workspaces/${request.workspaceId}`}>{tr.provisioned}</Link>
              </Button>
            )}
            {canManage && open && (
              <>
                <Button size="sm" onClick={() => router.push(`/partner/workspaces?provision=${request.id}`)}>
                  {tr.provision}
                </Button>
                {request.status === 'new' && (
                  <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => void setStatus('contacted')}>
                    {tr.markContacted}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => void setStatus('declined')}>
                  {tr.decline}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
