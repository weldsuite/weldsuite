/**
 * Custom collector domains on the install tab, as the standard list (a row
 * opens the domain's DNS records and snippet in place): add a host name of the
 * customer's own, show the DNS records to add (with copy buttons), its
 * status, check now, remove. Off ("not available yet") where the API answers
 * 503: no provider is set up there (Cloudflare for SaaS on Global,
 * cert-manager on the Kubernetes editions, ADR PANEL-014).
 * `panel_projects:manage` only.
 */

import { useState } from 'react';
import { ArrowLeft, Check, Copy, Globe, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { isHostname, type PanelDomainDto, type PanelDomainStatus } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState, InlineError } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
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

type RecordRow = PanelDomainDto['records'][number] & { id: string };

function RefreshButton({ projectId, domain }: Readonly<{ projectId: string; domain: PanelDomainDto }>) {
  const { t } = useI18n();
  const td = t.weldpanel.collab.domains;
  const refresh = useRefreshWeldPanelDomain(projectId);
  if (domain.status === 'deleting') return null;
  async function check() {
    try {
      await refresh.mutateAsync(domain.id);
      toast.success(td.refreshed);
    } catch {
      toast.error(td.refreshFailed);
    }
  }
  return (
    <Button type="button" variant="ghost" size="sm" className="h-7" disabled={refresh.isPending} onClick={() => void check()}>
      {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      {td.refresh}
    </Button>
  );
}

/** One domain opened in place: what to add at the DNS provider, or the snippet once it is active. */
function DomainDetail({ projectId, domain, onBack }: Readonly<{ projectId: string; domain: PanelDomainDto; onBack: () => void }>) {
  const { t, language, format } = useI18n();
  const td = t.weldpanel.collab.domains;
  const records: RecordRow[] = domain.records.map((r) => ({ ...r, id: `${r.type}:${r.name}:${r.value}` }));
  const columns: ColumnDef<RecordRow>[] = [
    { id: 'type', header: td.records.type, width: 'w-[80px]', render: (r) => <span className="font-mono text-xs">{r.type}</span> },
    { id: 'name', header: td.records.name, width: 'flex-1 min-w-[140px]', render: (r) => <CopyValue value={r.name} label={td.records.name} /> },
    { id: 'value', header: td.records.value, width: 'flex-1 min-w-[140px]', render: (r) => <CopyValue value={r.value} label={td.records.value} /> },
    { id: 'purpose', header: td.records.purpose, width: 'hidden sm:block sm:w-[120px]', render: (r) => <span className="text-muted-foreground">{td.purposes[r.purpose]}</span> },
  ];
  return (
    <div data-testid="weldpanel-domain">
      <div className="flex h-[53px] items-center gap-2 border-b border-border px-3 md:px-4">
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t.common.actions.back} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <span className="min-w-0 truncate font-mono text-sm font-medium">{domain.hostname}</span>
        <SoftBadge tone={STATUS_TONES[domain.status]}>{td.statuses[domain.status]}</SoftBadge>
        <div className="ml-auto">
          <RefreshButton projectId={projectId} domain={domain} />
        </div>
      </div>
      <div className="grid gap-3 px-3 py-3 md:px-4">
        {domain.lastError && <InlineError>{format(td.lastError, { error: domain.lastError })}</InlineError>}
        {domain.status === 'deleting' && <p className="text-sm text-muted-foreground">{td.removing}</p>}
        {domain.sslStatus && <p className="text-xs text-muted-foreground">{format(td.certificate, { status: domain.sslStatus })}</p>}
        {domain.lastCheckedAt && <p className="text-xs text-muted-foreground">{format(td.lastChecked, { date: formatDateTime(domain.lastCheckedAt, language) })}</p>}
        {domain.status === 'active' && domain.snippet && (
          <CopyBlock title={format(td.snippetTitle, { hostname: domain.hostname })} description={td.snippetDescription} value={domain.snippet} />
        )}
      </div>
      {domain.status !== 'active' && domain.status !== 'deleting' && records.length > 0 && (
        <>
          <p className="px-3 pb-2 text-sm font-medium md:px-4">{td.recordsTitle}</p>
          <PanelEntityList<RecordRow> items={records} isLoading={false} columns={columns} hideTopBar emptyState={{ title: td.empty, description: '' }} />
        </>
      )}
    </div>
  );
}

function AddDomainDialog({ open, onOpenChange, projectId }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; projectId: string }>) {
  const { t } = useI18n();
  const td = t.weldpanel.collab.domains;
  const tc = t.weldpanel.analytics.common;
  const create = useCreateWeldPanelDomain(projectId);
  const [hostname, setHostname] = useState('');
  const [invalid, setInvalid] = useState(false);

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
      onOpenChange(false);
      toast.success(td.added);
    } catch (err) {
      toast.error(isApiError(err) && err.status === 400 ? td.invalid : td.addFailed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (create.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{td.title}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="grid gap-1.5">
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
            {invalid && <InlineError>{td.invalid}</InlineError>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
              {tc.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending || hostname.trim() === ''}>
              {create.isPending && <Loader2 className="animate-spin" />}
              {td.add}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DomainsSection({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format } = useI18n();
  const td = t.weldpanel.collab.domains;
  const tc = t.weldpanel.analytics.common;
  const { data: domains, isLoading, error, refetch } = useWeldPanelDomains(projectId);
  const remove = useDeleteWeldPanelDomain(projectId);
  const refresh = useRefreshWeldPanelDomain(projectId);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PanelDomainDto | null>(null);

  async function check(domain: PanelDomainDto) {
    try {
      await refresh.mutateAsync(domain.id);
      toast.success(td.refreshed);
    } catch {
      toast.error(td.refreshFailed);
    }
  }

  const columns: ColumnDef<PanelDomainDto>[] = [
    {
      id: 'hostname',
      header: td.hostnameLabel,
      width: 'flex-1 min-w-[160px]',
      render: (domain) => (
        <span className="flex min-w-0 items-center gap-2">
          <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-sm font-medium">{domain.hostname}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: t.weldpanel.observe.keys.columns.status,
      width: 'w-[150px]',
      render: (domain) => <SoftBadge tone={STATUS_TONES[domain.status]}>{td.statuses[domain.status]}</SoftBadge>,
    },
  ];

  const opened = (domains ?? []).find((d) => d.id === openId);
  let body: React.ReactNode;
  if (isLoading) body = <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  else if (isDomainsUnavailable(error)) body = <InfoBanner variant="neutral">{td.unavailable}</InfoBanner>;
  else if (error) body = <ErrorState message={td.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  else if (opened) body = <DomainDetail projectId={projectId} domain={opened} onBack={() => setOpenId(null)} />;
  else
    body = (
      <PanelEntityList<PanelDomainDto>
        items={domains ?? []}
        isLoading={false}
        columns={columns}
        hideFilter
        onRowClick={(domain) => setOpenId(domain.id)}
        rowMenu={(domain) =>
          domain.status === 'deleting' ? null : (
            <>
              <DropdownMenuItem onSelect={() => void check(domain)}>
                <RefreshCw />
                {td.refresh}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setRemoving(domain)}>
                {td.remove}
              </DropdownMenuItem>
            </>
          )
        }
        createButton={{ label: td.add, onClick: () => setAdding(true) }}
        emptyState={{ icon: <Globe className="size-8 text-muted-foreground" />, title: td.empty, description: td.description, action: { label: td.add, onClick: () => setAdding(true) } }}
      />
    );

  return (
    <div>
      {body}
      <AddDomainDialog open={adding} onOpenChange={setAdding} projectId={projectId} />
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
    </div>
  );
}
