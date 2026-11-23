/**
 * The addresses of an online store: the free `{name}.<base domain>` address
 * (claimed once) and the merchant's own domains. A custom domain lists the
 * DNS records to create at the domain provider (ownership TXT, then CNAME or,
 * for an apex domain, A/AAAA records), each with copy buttons, and shows its
 * DNS and certificate status, the last problem, and actions to check again,
 * make it the primary address or remove it. Changes need `websites:manage`.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Check, Copy, ExternalLink, Loader2, RefreshCw, Star, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState, InlineError } from '@weldsuite/ui/components/error-banner';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  onlineStoreErrorCode,
  useCreateStorefrontHost,
  useDeleteStorefrontHost,
  useMakeStorefrontHostPrimary,
  useRefreshStorefrontHost,
  useStorefrontHosts,
  useStorefrontHostsConfig,
  type HostDnsRecord,
  type HostSslStatus,
  type HostStatus,
  type OnlineStoreSite,
  type StorefrontHost,
  type StorefrontHostsConfig,
} from '@/hooks/queries/use-online-store-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import { useCopy } from '@/app/weldcommerce/lib/copy-box';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';

const STATUS_TONES: Record<HostStatus, SoftTone> = { pending: 'warning', active: 'success', failed: 'danger' };
const SSL_TONES: Record<HostSslStatus, SoftTone> = { issuing: 'warning', active: 'success', failed: 'danger' };

/** A free address's name: lowercase letters, digits and hyphens, starting and ending with a letter or digit. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A host name with at least one dot, without a scheme, path or port. */
export const HOSTNAME_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const identifierProps = { autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } as const;

function hostErrorMessage(err: unknown, kind: 'address' | 'domains'): string | null {
  const t = getTranslations('commerce').onlineStore.settingsTab;
  switch (onlineStoreErrorCode(err)) {
    case 'HOST_TAKEN':
      return kind === 'address' ? t.address.taken : t.domains.taken;
    case 'HOST_RESERVED':
      return kind === 'address' ? t.address.reserved : t.domains.reserved;
    case 'HOST_INVALID':
      return kind === 'address' ? t.address.invalid : t.domains.hostnameInvalid;
    default:
      return null;
  }
}

/** A small copy button for one value of a DNS record; says "Copied" in a status region next to it. */
function CopyValueButton({ value, label }: Readonly<{ value: string; label: string }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.domains;
  const { state, message, copy } = useCopy(value, { copied: t.copied, copyFailed: t.copyFailed });
  const Icon = state === 'copied' ? Check : Copy;
  return (
    <span className="inline-flex items-center">
      <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} onClick={() => void copy()}>
        <Icon className="size-3.5" aria-hidden="true" />
      </Button>
      <span role="status" className="sr-only">
        {message}
      </span>
    </span>
  );
}

function DnsRecords({ records, config }: Readonly<{ records: HostDnsRecord[]; config: StorefrontHostsConfig | undefined }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.domains;
  const apex = records.some((record) => record.type === 'A' || record.type === 'AAAA');
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t.records}</h4>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.columns.type}</TableHead>
              <TableHead>{t.columns.name}</TableHead>
              <TableHead>{t.columns.value}</TableHead>
              <TableHead className="hidden @2xl:table-cell">{t.columns.purpose}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <TableRow key={`${record.type}:${record.name}:${record.value}`}>
                <TableCell className="font-mono text-xs">{record.type}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1">
                    <code className="font-mono text-xs break-all">{record.name}</code>
                    <CopyValueButton value={record.name} label={fill(t.copyName, { type: record.type })} />
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1">
                    <code className="font-mono text-xs break-all">{record.value}</code>
                    <CopyValueButton value={record.value} label={fill(t.copyValue, { type: record.type })} />
                  </span>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground @2xl:table-cell">{t.purpose[record.purpose] ?? record.purpose}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {apex && config && config.apexAddresses.length > 0 && <p className="text-xs text-muted-foreground">{t.apexHint}</p>}
    </div>
  );
}

function HostCard({
  host,
  siteId,
  canManage,
  config,
  showRecords,
}: Readonly<{ host: StorefrontHost; siteId: string; canManage: boolean; config: StorefrontHostsConfig | undefined; showRecords: boolean }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.domains;
  const saveFailed = getTranslations('commerce').common.saveFailed;
  const refresh = useRefreshStorefrontHost();
  const primary = useMakeStorefrontHostPrimary();
  const remove = useDeleteStorefrontHost();
  const [removing, setRemoving] = useState(false);

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast.success(success);
    } catch (err) {
      toast.error(errorMessage(err, saveFailed));
    }
  };

  return (
    <li className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={host.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium break-all underline-offset-4 hover:underline"
              aria-label={fill(t.open, { host: host.hostname })}
            >
              {host.hostname}
              <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
            </a>
            {host.isPrimary && <SoftBadge tone="success">{t.primary}</SoftBadge>}
            <SoftBadge tone={STATUS_TONES[host.status] ?? 'neutral'}>{t.status[host.status] ?? host.status}</SoftBadge>
            {host.sslStatus && <SoftBadge tone={SSL_TONES[host.sslStatus] ?? 'neutral'}>{t.ssl[host.sslStatus] ?? host.sslStatus}</SoftBadge>}
          </div>
          <p className="text-xs text-muted-foreground">
            {host.lastCheckedAt ? fill(t.lastChecked, { date: formatPanelDate(host.lastCheckedAt) ?? '' }) : t.notChecked}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={fill(t.refreshLabel, { host: host.hostname })}
              disabled={refresh.isPending}
              onClick={() => void run(() => refresh.mutateAsync({ siteId, hostId: host.id }), fill(t.refreshed, { host: host.hostname }))}
            >
              {refresh.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
              {t.refresh}
            </Button>
            {!host.isPrimary && host.status === 'active' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={fill(t.makePrimaryLabel, { host: host.hostname })}
                onClick={() => void run(() => primary.mutateAsync({ siteId, hostId: host.id }), fill(t.madePrimary, { host: host.hostname }))}
              >
                <Star className="size-4" aria-hidden="true" />
                {t.makePrimary}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" aria-label={fill(t.removeLabel, { host: host.hostname })} onClick={() => setRemoving(true)}>
              <Trash2 className="size-4" aria-hidden="true" />
              {t.remove}
            </Button>
          </div>
        )}
      </div>
      {host.lastError && <InlineError>{fill(t.lastError, { error: host.lastError })}</InlineError>}
      {showRecords && host.dnsRecords.length > 0 && <DnsRecords records={host.dnsRecords} config={config} />}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t.removeTitle}
        description={fill(t.removeDescription, { host: host.hostname })}
        variant="destructive"
        confirmLabel={t.remove}
        cancelLabel={getTranslations('common').actions.cancel}
        onConfirm={async () => {
          await run(() => remove.mutateAsync({ siteId, hostId: host.id }), t.removed);
          setRemoving(false);
        }}
      />
    </li>
  );
}

function ClaimAddressForm({ siteId, baseDomain }: Readonly<{ siteId: string; baseDomain: string }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.address;
  const create = useCreateStorefrontHost();
  const form = useForm<{ subdomain: string }>({
    resolver: zodResolver(z.object({ subdomain: z.string().trim().toLowerCase().regex(SUBDOMAIN_PATTERN, t.invalid) })),
    defaultValues: { subdomain: '' },
  });

  const onSubmit = async ({ subdomain }: { subdomain: string }) => {
    try {
      await create.mutateAsync({ siteId, subdomain: subdomain.trim().toLowerCase() });
      toast.success(t.claimed);
    } catch (err) {
      const message = hostErrorMessage(err, 'address');
      if (message) form.setError('subdomain', { type: 'server', message }, { shouldFocus: true });
      else toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-wrap items-start gap-2">
        <FormField
          control={form.control}
          name="subdomain"
          render={({ field }) => (
            <FormItem className="min-w-[16rem] flex-1">
              <FormLabel>{t.slug}</FormLabel>
              <div className="flex items-center gap-1">
                <FormControl>
                  <Input {...field} {...identifierProps} maxLength={63} placeholder="myshop" className="font-mono" />
                </FormControl>
                <span className="font-mono text-sm whitespace-nowrap text-muted-foreground">.{baseDomain}</span>
              </div>
              <FormDescription>{t.slugHint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="mt-[1.375rem]" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {t.claim}
        </Button>
      </form>
    </Form>
  );
}

function AddDomainForm({ siteId }: Readonly<{ siteId: string }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab.domains;
  const create = useCreateStorefrontHost();
  const form = useForm<{ hostname: string }>({
    resolver: zodResolver(z.object({ hostname: z.string().trim().toLowerCase().regex(HOSTNAME_PATTERN, t.hostnameInvalid) })),
    defaultValues: { hostname: '' },
  });

  const onSubmit = async ({ hostname }: { hostname: string }) => {
    try {
      await create.mutateAsync({ siteId, hostname: hostname.trim().toLowerCase() });
      toast.success(t.added);
      form.reset({ hostname: '' });
    } catch (err) {
      const message = hostErrorMessage(err, 'domains');
      if (message) form.setError('hostname', { type: 'server', message }, { shouldFocus: true });
      else toast.error(errorMessage(err, getTranslations('commerce').common.saveFailed));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-wrap items-start gap-2">
        <FormField
          control={form.control}
          name="hostname"
          render={({ field }) => (
            <FormItem className="min-w-[16rem] flex-1">
              <FormLabel>{t.hostname}</FormLabel>
              <FormControl>
                <Input {...field} {...identifierProps} inputMode="url" maxLength={253} placeholder={t.hostnamePlaceholder} className="font-mono" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="mt-[1.375rem]" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {t.add}
        </Button>
      </form>
    </Form>
  );
}

export function OnlineStoreHostsSection({ site, canManage }: Readonly<{ site: OnlineStoreSite; canManage: boolean }>) {
  const t = getTranslations('commerce').onlineStore.settingsTab;
  const config = useStorefrontHostsConfig();
  const hosts = useStorefrontHosts(site.id);

  if (config.isPending || hosts.isPending) return <PageLoader fullScreen={false} />;
  if (config.isError || hosts.isError) {
    return (
      <ErrorState
        message={t.loadFailed}
        onRetry={() => {
          void config.refetch();
          void hosts.refetch();
        }}
      />
    );
  }

  const settings = config.data.data;
  const rows = hosts.data.data ?? [];
  const free = rows.filter((host) => host.kind === 'subdomain');
  const custom = rows.filter((host) => host.kind === 'custom');

  let freeBody;
  if (free.length > 0) {
    freeBody = (
      <ul className="space-y-3">
        {free.map((host) => (
          <HostCard key={host.id} host={host} siteId={site.id} canManage={canManage} config={settings} showRecords={false} />
        ))}
      </ul>
    );
  } else if (!settings.available) freeBody = <EmptyText>{t.address.unavailable}</EmptyText>;
  else if (canManage) freeBody = <ClaimAddressForm siteId={site.id} baseDomain={settings.baseDomain} />;
  else freeBody = <EmptyText>{t.address.readOnly}</EmptyText>;

  return (
    <div className="space-y-8">
      <SettingsSection title={t.address.title} description={settings.available ? fill(t.address.description, { domain: settings.baseDomain }) : undefined}>
        {freeBody}
      </SettingsSection>
      <SettingsSection title={t.domains.title} description={settings.customDomains ? t.domains.description : undefined}>
        {settings.customDomains ? (
          <>
            {canManage ? <AddDomainForm siteId={site.id} /> : <p className="text-sm text-muted-foreground">{t.domains.readOnly}</p>}
            {custom.length === 0 ? (
              <EmptyText>{t.domains.empty}</EmptyText>
            ) : (
              <ul className="space-y-3">
                {custom.map((host) => (
                  <HostCard key={host.id} host={host} siteId={site.id} canManage={canManage} config={settings} showRecords />
                ))}
              </ul>
            )}
            {rows.length > 1 && <p className="text-xs text-muted-foreground">{t.domains.primaryHint}</p>}
          </>
        ) : (
          <EmptyText>{t.domains.unavailable}</EmptyText>
        )}
      </SettingsSection>
    </div>
  );
}
