/**
 * Custom collector domains on the install tab: add a host name of the
 * customer's own, show the DNS records to add (with copy buttons), its
 * status, check now, remove. Off ("not available yet") where the API answers
 * 503: no provider is set up there (Cloudflare for SaaS on Global,
 * cert-manager on the Kubernetes editions, ADR PANEL-014).
 * `panel_projects:manage` only.
 */

import { useState } from 'react';
import { Check, Copy, Globe, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { isHostname, type PanelDomainDto, type PanelDomainStatus } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState, InlineError } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useCreateWeldPanelDomain, useDeleteWeldPanelDomain, useRefreshWeldPanelDomain, useWeldPanelDomains } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { CopyBlock } from '../components/copy-block';
import { formatDateTime } from '../lib/format';

const STATUS_TONES: Record<PanelDomainStatus, SoftTone> = { pending: 'warning', active: 'success', failed: 'danger', deleting: 'neutral' };

/** 503 `FEATURE_UNAVAILABLE`: custom domains are not set up in this environment. */
export function isDomainsUnavailable(error: unknown): boolean {
  return isApiError(error) && error.status === 503;
}

function CopyValue({ value, label }: Readonly<{ value: string; label: string }>) {
  const { t, format } = useI18n();
  const td = t.weldpanel.collab.domains;
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t.weldpanel.install.copyFailed);
    }
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <code className="min-w-0 truncate font-mono text-xs" title={value}>
        {value}
      </code>
      <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" onClick={() => void copy()} aria-label={format(td.copy, { label })}>
        {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      </Button>
    </span>
  );
}

function DomainItem({ projectId, domain, onRemove }: Readonly<{ projectId: string; domain: PanelDomainDto; onRemove: () => void }>) {
  const { t, language, format } = useI18n();
  const td = t.weldpanel.collab.domains;
  const refresh = useRefreshWeldPanelDomain(projectId);

  async function check() {
    try {
      await refresh.mutateAsync(domain.id);
      toast.success(td.refreshed);
    } catch {
      toast.error(td.refreshFailed);
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border p-3" data-testid="weldpanel-domain">
      <div className="flex flex-wrap items-center gap-2">
        <Globe className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-mono text-sm font-medium">{domain.hostname}</span>
        <SoftBadge tone={STATUS_TONES[domain.status]}>{td.statuses[domain.status]}</SoftBadge>
        {domain.sslStatus && <span className="text-xs text-muted-foreground">{format(td.certificate, { status: domain.sslStatus })}</span>}
        <div className="ml-auto flex items-center gap-1">
          {domain.status !== 'deleting' && (
            <Button type="button" variant="ghost" size="sm" disabled={refresh.isPending} onClick={() => void check()}>
              {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {td.refresh}
            </Button>
          )}
          {domain.status !== 'deleting' && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove}>
              {td.remove}
            </Button>
          )}
        </div>
      </div>
      {domain.lastError && <InlineError>{format(td.lastError, { error: domain.lastError })}</InlineError>}
      {domain.status === 'deleting' && <p className="text-sm text-muted-foreground">{td.removing}</p>}
      {domain.status !== 'active' && domain.status !== 'deleting' && domain.records.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">{td.recordsTitle}</p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{td.records.type}</TableHead>
                  <TableHead>{td.records.name}</TableHead>
                  <TableHead>{td.records.value}</TableHead>
                  <TableHead className="hidden sm:table-cell">{td.records.purpose}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domain.records.map((record) => (
                  <TableRow key={`${record.type}:${record.name}:${record.value}`}>
                    <TableCell className="font-mono text-xs">{record.type}</TableCell>
                    <TableCell className="max-w-48">
                      <CopyValue value={record.name} label={td.records.name} />
                    </TableCell>
                    <TableCell className="max-w-64">
                      <CopyValue value={record.value} label={td.records.value} />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{td.purposes[record.purpose]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      {domain.lastCheckedAt && <p className="text-xs text-muted-foreground">{format(td.lastChecked, { date: formatDateTime(domain.lastCheckedAt, language) })}</p>}
      {domain.status === 'active' && domain.snippet && (
        <CopyBlock title={format(td.snippetTitle, { hostname: domain.hostname })} description={td.snippetDescription} value={domain.snippet} />
      )}
    </div>
  );
}

export function DomainsSection({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format } = useI18n();
  const td = t.weldpanel.collab.domains;
  const tc = t.weldpanel.analytics.common;
  const { data: domains, isLoading, error, refetch } = useWeldPanelDomains(projectId);
  const create = useCreateWeldPanelDomain(projectId);
  const remove = useDeleteWeldPanelDomain(projectId);
  const [hostname, setHostname] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [removing, setRemoving] = useState<PanelDomainDto | null>(null);

  async function add() {
    const value = hostname.trim().toLowerCase();
    if (!isHostname(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    try {
      await create.mutateAsync(value);
      setHostname('');
      toast.success(td.added);
    } catch (err) {
      toast.error(isApiError(err) && err.status === 400 ? td.invalid : td.addFailed);
    }
  }

  let body: React.ReactNode;
  if (isLoading) body = <Skeleton className="h-20 w-full" />;
  else if (isDomainsUnavailable(error)) body = <InfoBanner variant="neutral">{td.unavailable}</InfoBanner>;
  else if (error) body = <ErrorState message={td.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  else
    body = (
      <div className="grid gap-3">
        {(domains ?? []).length === 0 && <p className="text-sm text-muted-foreground">{td.empty}</p>}
        {(domains ?? []).map((domain) => (
          <DomainItem key={domain.id} projectId={projectId} domain={domain} onRemove={() => setRemoving(domain)} />
        ))}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="grid min-w-56 flex-1 gap-1.5">
            <Label htmlFor="weldpanel-domain-hostname">{td.hostnameLabel}</Label>
            <Input
              id="weldpanel-domain-hostname"
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder={td.hostnamePlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid || undefined}
            />
          </div>
          <Button type="submit" disabled={create.isPending || hostname.trim() === ''}>
            {create.isPending && <Loader2 className="animate-spin" />}
            {td.add}
          </Button>
        </form>
        {invalid && <InlineError>{td.invalid}</InlineError>}
      </div>
    );

  return (
    <SectionCard title={td.title} description={td.description}>
      {body}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={format(td.removeTitle, { hostname: removing?.hostname ?? '' })}
        description={td.removeDescription}
        confirmLabel={td.remove}
        cancelLabel={tc.cancel}
        variant="destructive"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await remove.mutateAsync(removing.id);
            toast.success(td.removed);
            setRemoving(null);
          } catch {
            toast.error(td.removeFailed);
          }
        }}
      />
    </SectionCard>
  );
}
