'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Copy, Globe, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useCan } from '@weldsuite/permissions/react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useMailAppSettings } from '@/hooks/queries/use-app-settings-queries';
import {
  useCreateMailDomain,
  useDeleteMailDomain,
  useUpdateMailDomain,
  useVerifyMailDomain,
} from '@/hooks/queries/use-mail-queries';
import { getTranslations, type TranslationNamespaces } from '@/lib/i18n';
import { isRustBackend } from '@/lib/runtime-config';
import type { MailDnsRecord, MailDomainRow } from '@weldsuite/app-api-client/domains/mail-domains';
import { createMailDomainSchema } from '@weldsuite/app-api-client/schemas/mail-domains';
import { isSharedWeldMailDomain } from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { EmailAccount } from '../accounts/email-accounts-list';

type DomainLabels = TranslationNamespaces['settings']['weldmail']['domains'];

function isCustomMailDomain(domainName: string): boolean {
  return !isSharedWeldMailDomain(domainName);
}

function accountHost(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function MailDomainsSettingsPage() {
  const { data, isLoading } = useMailAppSettings();
  const ts = getTranslations('settings');
  const td = ts.weldmail.domains;
  const updateDomain = useUpdateMailDomain();
  const [pendingId, setPendingId] = useState<string | null>(null);
  // On the Kubernetes editions a mail domain is added and checked here: it
  // need not be a WeldHost zone, and the customer publishes its records at
  // their own DNS provider (ADR MAIL-010, MAIL-011). Global manages mail
  // domains through WeldHost, so this page only holds catch-all there.
  const selfServed = isRustBackend();

  const accounts = data?.accounts ?? [];
  const customDomains = useMemo(
    () => (data?.domains ?? []).filter((d) => isCustomMailDomain(d.domainName)),
    [data?.domains],
  );

  async function saveCatchAll(
    domain: MailDomainRow,
    patch: { catchAllEnabled?: boolean; catchAllAccountId?: string | null },
  ) {
    setPendingId(domain.id);
    try {
      await updateDomain.mutateAsync({ id: domain.id, data: patch });
      toast.success(td.messages.updated);
    } catch (err) {
      toast.error(errorMessage(err, td.messages.updateFailed));
    } finally {
      setPendingId(null);
    }
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  const empty = (
    <div className="flex flex-col items-center justify-center py-16">
      <EmptyStateIllustration>
        <Globe className="h-16 w-16 text-muted-foreground/50" />
      </EmptyStateIllustration>
      <h3 className="text-lg font-medium mb-1">{td.noDomains}</h3>
      <p className="text-sm text-muted-foreground max-w-md text-center">
        {selfServed ? td.selfServedNoDomainsDescription : td.noDomainsDescription}
      </p>
    </div>
  );

  if (!selfServed) {
    if (customDomains.length === 0) return empty;
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{td.description}</p>
        <ul className="divide-y rounded-lg border">
          {customDomains.map((domain) => (
            <li key={domain.id} className="p-4">
              <CatchAllSettings
                domain={domain}
                accounts={accounts}
                busy={pendingId === domain.id}
                labels={td}
                onSave={saveCatchAll}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{td.selfServedDescription}</p>
      <AddDomainForm labels={td} />
      {customDomains.length === 0 ? (
        empty
      ) : (
        <ul className="divide-y rounded-lg border">
          {customDomains.map((domain) => (
            <SelfServedDomainRow
              key={domain.id}
              domain={domain}
              accounts={accounts}
              busy={pendingId === domain.id}
              labels={td}
              onSaveCatchAll={saveCatchAll}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddDomainForm({ labels }: Readonly<{ labels: DomainLabels }>) {
  const canCreate = useCan('accounts:create');
  const createDomain = useCreateMailDomain();
  const [domainName, setDomainName] = useState('');

  if (!canCreate) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = domainName.trim().toLowerCase();
    if (!createMailDomainSchema.shape.domainName.safeParse(name).success) {
      toast.error(labels.invalidDomain);
      return;
    }
    // WeldMail's own domains stay with Global; the backend refuses them too.
    if (isSharedWeldMailDomain(name)) {
      toast.error(labels.weldmailDomain);
      return;
    }
    try {
      await createDomain.mutateAsync(name);
      setDomainName('');
      toast.success(labels.messages.added);
    } catch (err) {
      toast.error(errorMessage(err, labels.messages.addFailed));
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="mail-domain-name">{labels.addLabel}</Label>
        <Input
          id="mail-domain-name"
          value={domainName}
          placeholder={labels.addPlaceholder}
          autoComplete="off"
          onChange={(e) => setDomainName(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={createDomain.isPending || !domainName.trim()}>
        {createDomain.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        {labels.add}
      </Button>
    </form>
  );
}

function SelfServedDomainRow({
  domain,
  accounts,
  busy,
  labels,
  onSaveCatchAll,
}: Readonly<{
  domain: MailDomainRow;
  accounts: EmailAccount[];
  busy: boolean;
  labels: DomainLabels;
  onSaveCatchAll: (
    domain: MailDomainRow,
    patch: { catchAllEnabled?: boolean; catchAllAccountId?: string | null },
  ) => Promise<void>;
}>) {
  const canUpdate = useCan('accounts:update');
  const canDelete = useCan('accounts:delete');
  const verifyDomain = useVerifyMailDomain();
  const deleteDomain = useDeleteMailDomain();
  const verified = domain.dnsStatus === 'verified';
  // A pending domain shows what to publish; a verified one on request.
  const [showRecords, setShowRecords] = useState(!verified);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!verified) setShowRecords(true);
  }, [verified]);

  async function check() {
    try {
      const result = await verifyDomain.mutateAsync(domain.id);
      if (result.data.dnsStatus === 'verified') toast.success(labels.messages.verified);
      else toast.info(labels.messages.stillPending);
    } catch (err) {
      toast.error(errorMessage(err, labels.messages.checkFailed));
    }
  }

  async function remove() {
    try {
      await deleteDomain.mutateAsync(domain.id);
      setConfirmRemove(false);
      toast.success(labels.messages.removed);
    } catch (err) {
      toast.error(errorMessage(err, labels.messages.removeFailed));
    }
  }

  const records = domain.dnsRecords ?? [];

  return (
    <li className="space-y-4 p-4" data-testid={`mail-domain-${domain.domainName}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate font-medium">{domain.domainName}</p>
          <SoftBadge tone={verified ? 'success' : 'warning'}>
            {verified ? labels.statusVerified : labels.statusPending}
          </SoftBadge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {records.length > 0 && verified && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowRecords((v) => !v)}>
              {showRecords ? labels.hideRecords : labels.showRecords}
            </Button>
          )}
          {canUpdate && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={verifyDomain.isPending}
              onClick={check}
            >
              {verifyDomain.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-4 w-4" />
              )}
              {labels.check}
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {labels.remove}
            </Button>
          )}
        </div>
      </div>

      {showRecords && records.length > 0 && (
        <div className="space-y-2">
          {!verified && <p className="text-sm text-muted-foreground">{labels.recordsHint}</p>}
          <DnsRecordsTable records={records} labels={labels} />
        </div>
      )}

      {verified && (
        <CatchAllSettings
          domain={domain}
          accounts={accounts}
          busy={busy}
          labels={labels}
          onSave={onSaveCatchAll}
          heading={labels.catchAll}
        />
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={labels.removeTitle.replace('{domain}', domain.domainName)}
        description={labels.removeDescription}
        confirmLabel={labels.remove}
        variant="destructive"
        loading={deleteDomain.isPending}
        onConfirm={remove}
      />
    </li>
  );
}

function DnsRecordsTable({
  records,
  labels,
}: Readonly<{ records: MailDnsRecord[]; labels: DomainLabels }>) {
  const purposeLabel = (purpose: MailDnsRecord['purpose']) =>
    purpose && purpose in labels.purposes
      ? labels.purposes[purpose as keyof DomainLabels['purposes']]
      : '';

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(labels.messages.copied);
    } catch {
      // Clipboard access denied: the value stays selectable in the table.
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{labels.columns.purpose}</TableHead>
          <TableHead>{labels.columns.type}</TableHead>
          <TableHead>{labels.columns.name}</TableHead>
          <TableHead>{labels.columns.value}</TableHead>
          <TableHead>{labels.columns.priority}</TableHead>
          <TableHead>{labels.columns.status}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={`${record.type}-${record.name}-${record.purpose ?? ''}`}>
            <TableCell className="whitespace-nowrap">{purposeLabel(record.purpose)}</TableCell>
            <TableCell className="font-mono text-xs">{record.type}</TableCell>
            <TableCell className="max-w-[220px] break-all font-mono text-xs">{record.name}</TableCell>
            <TableCell className="max-w-[320px]">
              <div className="flex items-start gap-1">
                <span className="break-all font-mono text-xs">{record.value}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"
                  aria-label={labels.copy}
                  onClick={() => copy(record.value)}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </TableCell>
            <TableCell className="font-mono text-xs">{record.priority ?? ''}</TableCell>
            <TableCell className="whitespace-nowrap">
              {record.verified ? (
                <span className="flex items-center gap-1 text-xs text-green-600">
                  <CheckCircle2 className="size-3.5" />
                  {labels.recordFound}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Circle className="size-3.5" />
                  {labels.recordMissing}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CatchAllSettings({
  domain,
  accounts,
  busy,
  labels,
  onSave,
  heading,
}: Readonly<{
  domain: MailDomainRow;
  accounts: EmailAccount[];
  busy: boolean;
  /** The block's title; the domain's name where nothing above names it. */
  heading?: string;
  labels: {
    catchAll: string;
    catchAllHint: string;
    mailbox: string;
    mailboxPlaceholder: string;
    enableNeedsMailbox: string;
  };
  onSave: (
    domain: MailDomainRow,
    patch: { catchAllEnabled?: boolean; catchAllAccountId?: string | null },
  ) => Promise<void>;
}>) {
  const domainAccounts = accounts.filter(
    (a) => accountHost(a.email) === domain.domainName.toLowerCase() && a.status !== 'inactive',
  );
  const [draftAccountId, setDraftAccountId] = useState(domain.catchAllAccountId ?? '');

  useEffect(() => {
    setDraftAccountId(domain.catchAllAccountId ?? '');
  }, [domain.catchAllAccountId]);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="font-medium truncate">{heading ?? domain.domainName}</p>
        <p className="text-sm text-muted-foreground">{labels.catchAllHint}</p>
      </div>

      <div className="flex flex-col gap-3 sm:items-end sm:min-w-[240px]">
        <div className="flex items-center gap-2">
          <Switch
            id={`catch-all-${domain.id}`}
            checked={domain.catchAllEnabled}
            disabled={busy || (domainAccounts.length === 0 && !domain.catchAllEnabled)}
            onCheckedChange={async (checked) => {
              if (checked && !draftAccountId) {
                toast.error(labels.enableNeedsMailbox);
                return;
              }
              await onSave(domain, {
                catchAllEnabled: checked,
                catchAllAccountId: checked ? draftAccountId : null,
              });
              if (!checked) setDraftAccountId('');
            }}
          />
          <Label htmlFor={`catch-all-${domain.id}`}>{labels.catchAll}</Label>
        </div>

        <div className="w-full sm:w-[240px] space-y-1.5">
          <Label className="text-xs text-muted-foreground">{labels.mailbox}</Label>
          <Select
            value={draftAccountId || undefined}
            disabled={busy || domainAccounts.length === 0}
            onValueChange={async (accountId) => {
              setDraftAccountId(accountId);
              await onSave(domain, {
                catchAllAccountId: accountId,
                ...(domain.catchAllEnabled ? { catchAllEnabled: true } : {}),
              });
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={labels.mailboxPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {domainAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
