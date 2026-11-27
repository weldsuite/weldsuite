/**
 * Settings → Apps → WeldForms → Custom domains: connect the workspace's own
 * domain (forms.acme.com) so form links, QR codes, embeds and invitations use
 * it. EU and self-hosted editions only; the page renders this behind
 * `isFeatureAvailable('forms-custom-domains')`.
 */

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { RefreshCw, Star, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { addFormDomainSchema, type AddFormDomainInput, type FormDomain, type FormDomainDnsRecord, type FormDomainsConfig } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { CopyButton } from '@weldsuite/ui/components/copy-button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FormField } from '@weldsuite/ui/components/form-field';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  formDomainErrorCode,
  useAddFormDomain,
  useFormDomains,
  useFormDomainsConfig,
  useForms,
  useMakeFormDomainPrimary,
  useRefreshFormDomain,
  useRemoveFormDomain,
  useUpdateFormDomain,
} from '@/hooks/queries/use-weldforms-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Section } from './settings-section';

type DomainStrings = ReturnType<typeof useI18n>['t']['weldforms']['workspaceSettings']['domains'];

const NO_HOME_FORM = '__none__';

function useDomainErrorMessage() {
  const { t } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  return (err: unknown): string => {
    switch (formDomainErrorCode(err)) {
      case 'HOST_TAKEN':
        return td.errorHostTaken;
      case 'HOST_RESERVED':
        return td.errorHostReserved;
      case 'TOO_MANY_DOMAINS':
        return td.errorTooMany;
      case 'VALIDATION_ERROR':
        return td.errorInvalid;
      case 'FEATURE_UNAVAILABLE':
        return td.errorUnavailable;
      case 'DOMAIN_NOT_ACTIVE':
        return td.errorNotActive;
      default:
        return td.errorGeneric;
    }
  };
}

export function DomainsSection({ canManage }: Readonly<{ canManage: boolean }>) {
  const { t } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  const config = useFormDomainsConfig();
  const available = config.data?.available === true;
  const domains = useFormDomains(available);

  if (config.isLoading || (available && domains.isLoading)) {
    return (
      <Section title={td.title} description={td.description}>
        <PageLoader fullScreen={false} />
      </Section>
    );
  }
  if (config.error || !config.data || (available && domains.error)) {
    const retry = config.error || !config.data ? config.refetch : domains.refetch;
    return (
      <Section title={td.title} description={td.description}>
        <ErrorState
          message={td.loadFailed}
          onRetry={() => void retry()}
          retryLabel={t.common.actions.retry}
        />
      </Section>
    );
  }
  if (!config.data.available) {
    return (
      <Section title={td.title} description={td.description}>
        <InfoBanner variant="info">{td.unavailable}</InfoBanner>
      </Section>
    );
  }

  const list = domains.data ?? [];
  return (
    <Section title={td.title} description={td.description}>
      <DomainsHelp config={config.data} />
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.empty}</p>
      ) : (
        <ul className="space-y-3">
          {list.map((domain) => (
            <DomainCard key={domain.id} domain={domain} canManage={canManage} />
          ))}
        </ul>
      )}
      {canManage && <AddDomainForm atLimit={list.length >= config.data.maxDomains} maxDomains={config.data.maxDomains} />}
    </Section>
  );
}

function DomainsHelp({ config }: Readonly<{ config: FormDomainsConfig }>) {
  const { t, format } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>
        {config.cnameTarget ? (
          format(td.howTo, { target: config.cnameTarget })
        ) : (
          td.howToNoTarget
        )}
      </p>
      {config.apexAddresses.length > 0 && <p>{td.howToApex}</p>}
      <p>{td.primaryExplain}</p>
      <p>{format(td.limit, { max: config.maxDomains })}</p>
    </div>
  );
}

function AddDomainForm({ atLimit, maxDomains }: Readonly<{ atLimit: boolean; maxDomains: number }>) {
  const { t, format } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  const add = useAddFormDomain();
  const errorMessage = useDomainErrorMessage();
  const { register, handleSubmit, reset, formState } = useForm<AddFormDomainInput>({
    resolver: zodResolver(addFormDomainSchema),
    defaultValues: { hostname: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await add.mutateAsync({ hostname: values.hostname.trim().toLowerCase() });
      toast.success(td.added);
      reset();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-2 sm:flex-row sm:items-end" noValidate>
      <FormField
        label={td.addLabel}
        htmlFor="forms-domain-hostname"
        className="min-w-0 flex-1"
        helpText={atLimit ? format(td.limit, { max: maxDomains }) : undefined}
        error={formState.errors.hostname ? td.errorInvalid : undefined}
      >
        <Input
          id="forms-domain-hostname"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={td.addPlaceholder}
          disabled={atLimit}
          aria-invalid={formState.errors.hostname ? true : undefined}
          {...register('hostname')}
        />
      </FormField>
      <Button type="submit" disabled={atLimit || add.isPending}>
        {td.add}
      </Button>
    </form>
  );
}

function statusBadge(domain: FormDomain, td: DomainStrings): { tone: SoftTone; label: string } {
  if (domain.status === 'active') return { tone: 'success', label: td.statusActive };
  if (domain.status === 'failed') return { tone: 'danger', label: td.statusFailed };
  return { tone: 'warning', label: td.statusPending };
}

function sslBadge(domain: FormDomain, td: DomainStrings): { tone: SoftTone; label: string } | null {
  if (domain.sslStatus === 'issuing') return { tone: 'warning', label: td.sslIssuing };
  if (domain.sslStatus === 'active') return { tone: 'success', label: td.sslActive };
  if (domain.sslStatus === 'failed') return { tone: 'danger', label: td.sslFailed };
  return null;
}

function DomainCard({ domain, canManage }: Readonly<{ domain: FormDomain; canManage: boolean }>) {
  const { t, format, language } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  const errorMessage = useDomainErrorMessage();
  const refresh = useRefreshFormDomain();
  const makePrimary = useMakeFormDomainPrimary();
  const update = useUpdateFormDomain();
  const remove = useRemoveFormDomain();
  const forms = useForms({ status: 'published' });
  const [removing, setRemoving] = useState(false);

  const status = statusBadge(domain, td);
  const ssl = sslBadge(domain, td);
  const homeForms = forms.forms.filter((f): f is typeof f & { publicId: string } => f.publicId !== null);
  const homeValue = domain.homeFormPublicId ?? NO_HOME_FORM;
  const checkedAt = domain.lastCheckedAt ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(domain.lastCheckedAt)) : null;

  async function run<T>(action: () => Promise<T>, success: string) {
    try {
      await action();
      toast.success(success);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 break-all text-sm font-medium">{domain.hostname}</h3>
        {domain.isPrimary && <SoftBadge tone="neutral">{td.primaryBadge}</SoftBadge>}
        <SoftBadge tone={status.tone}>{status.label}</SoftBadge>
        {ssl && <SoftBadge tone={ssl.tone}>{ssl.label}</SoftBadge>}
        {canManage && (
          <div className="ms-auto flex flex-wrap gap-1">
            <Button type="button" variant="outline" size="sm" disabled={refresh.isPending} onClick={() => void run(() => refresh.mutateAsync(domain.id), td.checked)}>
              <RefreshCw className="size-4" />
              {td.checkNow}
            </Button>
            {domain.status === 'active' && !domain.isPrimary && (
              <Button type="button" variant="outline" size="sm" disabled={makePrimary.isPending} onClick={() => void run(() => makePrimary.mutateAsync(domain.id), format(td.primarySet, { hostname: domain.hostname }))}>
                <Star className="size-4" />
                {td.makePrimary}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(true)}>
              <Trash2 className="size-4" />
              {td.remove}
            </Button>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{checkedAt ? format(td.lastChecked, { date: checkedAt }) : td.neverChecked}</p>

      {domain.lastError && (
        <InfoBanner variant="danger" title={td.lastError}>
          {domain.lastError}
        </InfoBanner>
      )}

      {domain.dnsRecords.length > 0 && <DnsRecordsTable hostname={domain.hostname} records={domain.dnsRecords} />}

      <FormField label={td.homeForm} htmlFor={`forms-domain-home-${domain.id}`} helpText={format(td.homeFormHelp, { url: domain.url })}>
        <Select
          value={homeValue}
          disabled={!canManage || update.isPending}
          onValueChange={(value) => void run(() => update.mutateAsync({ id: domain.id, homeFormPublicId: value === NO_HOME_FORM ? null : value }), td.homeFormSaved)}
        >
          <SelectTrigger id={`forms-domain-home-${domain.id}`} className="w-full sm:max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_HOME_FORM}>{td.homeFormNone}</SelectItem>
            {homeForms.map((form) => (
              <SelectItem key={form.publicId} value={form.publicId}>
                {form.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={td.removeTitle}
        description={format(td.removeDescription, { hostname: domain.hostname })}
        confirmLabel={td.remove}
        variant="destructive"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(domain.id);
            toast.success(td.removed);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setRemoving(false);
          }
        }}
      />
    </li>
  );
}

function DnsRecordsTable({ hostname, records }: Readonly<{ hostname: string; records: FormDomainDnsRecord[] }>) {
  const { t, format } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  return (
    <div className="rounded-md border">
      <Table>
        <caption className="sr-only">{format(td.dnsRecordsCaption, { hostname })}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{td.colType}</TableHead>
            <TableHead scope="col">{td.colName}</TableHead>
            <TableHead scope="col">{td.colValue}</TableHead>
            <TableHead scope="col">{td.colPurpose}</TableHead>
            <TableHead scope="col">{td.colStatus}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={`${record.type}:${record.name}:${record.value}`}>
              <TableCell className="font-mono text-xs">{record.type}</TableCell>
              <TableCell>
                <CopyableValue value={record.name} field={td.colName} />
              </TableCell>
              <TableCell>
                <CopyableValue value={record.value} field={td.colValue} />
              </TableCell>
              <TableCell>{record.purpose === 'ownership' ? td.purposeOwnership : td.purposeRouting}</TableCell>
              <TableCell>
                <SoftBadge tone={record.satisfied ? 'success' : 'neutral'}>{record.satisfied ? td.satisfied : td.notSatisfied}</SoftBadge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CopyableValue({ value, field }: Readonly<{ value: string; field: string }>) {
  const { t, format } = useI18n();
  const td = t.weldforms.workspaceSettings.domains;
  return (
    <div className="flex items-center gap-1">
      <code className="min-w-0 break-all font-mono text-xs">{value}</code>
      <CopyButton value={value} label={format(td.copyField, { field })} copiedLabel={td.copied} failedLabel={td.copyFailed} />
    </div>
  );
}
