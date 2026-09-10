'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Globe } from 'lucide-react';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import { useMailAppSettings } from '@/hooks/queries/use-app-settings-queries';
import { useUpdateMailDomain } from '@/hooks/queries/use-mail-queries';
import { getTranslations } from '@/lib/i18n';
import type { MailDomainRow } from '@weldsuite/app-api-client/domains/mail-domains';
import type { EmailAccount } from '../accounts/email-accounts-list';

function isCustomMailDomain(domainName: string): boolean {
  const d = domainName.toLowerCase();
  return d !== 'weldmail.com' && !d.endsWith('.weldmail.com');
}

function accountHost(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

export default function MailDomainsSettingsPage() {
  const { data, isLoading } = useMailAppSettings();
  const ts = getTranslations('settings');
  const td = ts.weldmail.domains;
  const updateDomain = useUpdateMailDomain();
  const [pendingId, setPendingId] = useState<string | null>(null);

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
      const message = err instanceof Error ? err.message : td.messages.updateFailed;
      toast.error(message);
    } finally {
      setPendingId(null);
    }
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (customDomains.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <EmptyStateIllustration>
          <Globe className="h-16 w-16 text-muted-foreground/50" />
        </EmptyStateIllustration>
        <h3 className="text-lg font-medium mb-1">{td.noDomains}</h3>
        <p className="text-sm text-muted-foreground max-w-md text-center">
          {td.noDomainsDescription}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{td.description}</p>
      <ul className="divide-y rounded-lg border">
        {customDomains.map((domain) => (
          <DomainCatchAllRow
            key={domain.id}
            domain={domain}
            accounts={accounts}
            busy={pendingId === domain.id}
            labels={td}
            onSave={saveCatchAll}
          />
        ))}
      </ul>
    </div>
  );
}

function DomainCatchAllRow({
  domain,
  accounts,
  busy,
  labels,
  onSave,
}: {
  domain: MailDomainRow;
  accounts: EmailAccount[];
  busy: boolean;
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
}) {
  const domainAccounts = accounts.filter(
    (a) => accountHost(a.email) === domain.domainName.toLowerCase() && a.status !== 'inactive',
  );
  const [draftAccountId, setDraftAccountId] = useState(domain.catchAllAccountId ?? '');

  useEffect(() => {
    setDraftAccountId(domain.catchAllAccountId ?? '');
  }, [domain.catchAllAccountId]);

  return (
    <li className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="font-medium truncate">{domain.domainName}</p>
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
    </li>
  );
}
