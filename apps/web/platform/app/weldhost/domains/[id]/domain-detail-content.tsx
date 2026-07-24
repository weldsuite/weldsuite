
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from '@/lib/router';
import {
  Globe,
  AlertTriangle,
  Trash2,
  Copy,
  ExternalLink,
  RefreshCcw,
  Server,
  AlertCircle,
  X,
  ListCollapse,
  Settings as SettingsIcon,
  Lock,
  Building2,
  Tag,
  Clock,
  ShieldCheck,
  Shield,
  Mail,
  CircleDot,
  EllipsisVertical,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from '@/lib/utils';
import { Button } from "@weldsuite/ui/components/button";
import { Badge } from "@weldsuite/ui/components/badge";
import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weldsuite/ui/components/select";
import { Switch } from "@weldsuite/ui/components/switch";
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  useToggleAutoRenew,
  useCreateDnsRecord,
  useUpdateDnsRecord,
  useDeleteDnsRecord,
  isDnsRecordLocked,
  getDnsRecordLocks,
  type HostDnsRecord,
  type DnsRecordInput,
} from '@/hooks/queries/use-host-queries';
import { useI18n } from '@/lib/i18n/provider';
import type { Domain, ContactInput } from '@weldsuite/core-api-client/schemas/domains';
import type { DnsZone } from '@weldsuite/core-api-client/schemas/dns-zones';

type DomainContact = Partial<ContactInput>;

interface DomainDetailContentProps {
  domain: Domain;
  dnsZone?: DnsZone | null;
  dnsRecords: HostDnsRecord[];
  dnsTemplates: unknown[];
  zoneSyncMeta?: { id: string; syncedAt: string | null; syncError: string | null } | null;
  onClose?: () => void;
}

const DNS_RECORD_TYPES: DnsRecordInput['type'][] = [
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA',
];

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';

const statusPill: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950' },
  pending: { label: 'Pending', color: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950' },
  expired: { label: 'Expired', color: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950' },
  suspended: { label: 'Suspended', color: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950' },
  cancelled: { label: 'Cancelled', color: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary' },
};

function parseRecordForm(form: FormData, td: ReturnType<typeof useI18n>['t']['host']['domainDetail']): DnsRecordInput | { error: string } {
  const type = String(form.get('type') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const value = String(form.get('value') ?? '').trim();
  const ttlRaw = String(form.get('ttl') ?? '').trim();
  const priorityRaw = String(form.get('priority') ?? '').trim();

  if (!DNS_RECORD_TYPES.includes(type as DnsRecordInput['type'])) return { error: td.pickRecordType };
  if (!name) return { error: td.nameRequired };
  if (!value) return { error: td.valueRequired };

  const data: DnsRecordInput = {
    type: type as DnsRecordInput['type'],
    name,
    value,
  };
  if (ttlRaw) {
    const ttl = Number(ttlRaw);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 86400) return { error: td.ttlRange };
    data.ttl = ttl;
  }
  if (priorityRaw) {
    const priority = Number(priorityRaw);
    if (!Number.isFinite(priority) || priority < 0 || priority > 65535) {
      return { error: td.priorityRange };
    }
    data.priority = priority;
  }
  return data;
}

export function DomainDetailContent({
  domain,
  dnsZone,
  dnsRecords,
  onClose,
}: DomainDetailContentProps) {
  const { t } = useI18n();
  const td = t.host.domainDetail;

  const domainName = domain.fullDomain || domain.name;
  const nameservers: string[] =
    (Array.isArray(domain.nameservers) && domain.nameservers.length > 0
      ? domain.nameservers
      : (dnsZone?.externalNameservers as string[] | undefined)) || [];
  const zoneStatus = dnsZone?.status as string | undefined;

  useBreadcrumbs([
    { label: t.host.title, href: '/weldhost' },
    { label: t.host.domains.title, href: '/weldhost/domains' },
    { label: domainName }
  ]);

  const searchParams = useSearchParams();
  const [autoRenew, setAutoRenew] = useState(!!domain.autoRenew);
  const [activeTab, setActiveTab] = useState<'dns' | 'nameservers' | 'settings'>('dns');
  const toggleAutoRenewMutation = useToggleAutoRenew();
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const createDnsRecord = useCreateDnsRecord();
  const updateDnsRecord = useUpdateDnsRecord();
  const deleteDnsRecord = useDeleteDnsRecord();
  // Whether the zone is editable. Internally this is gated on having a
  // configured DNS provider; the UI never surfaces the provider name.
  const canManageDns = dnsZone?.provider === 'cloudflare' && !!dnsZone?.externalZoneId;

  const isExternalDomain = !!(domain.registrar && domain.registrar !== 'WeldHost');
  const status = statusPill[domain.status] ?? statusPill.active;

  useEffect(() => {
    setAutoRenew(!!domain.autoRenew);
  }, [domain.autoRenew]);

  useEffect(() => {
    if (searchParams.get('settings_saved')) {
      toast.success(td.settingsSaved);
      window.history.replaceState({}, '', `/weldhost/domains/${domain.id}`);
    }
    if (searchParams.get('settings_error')) {
      toast.error(td.settingsError);
      window.history.replaceState({}, '', `/weldhost/domains/${domain.id}`);
    }
    if (searchParams.get('external_added')) {
      toast.success(td.externalAdded);
      window.history.replaceState({}, '', `/weldhost/domains/${domain.id}`);
    }
  }, [searchParams, domain.id, td]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await toggleAutoRenewMutation.mutateAsync({ domainId: domain.id, enabled: autoRenew });
    } catch {
      toast.error(td.failedToSaveSettings);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(td.copiedToClipboard);
  };

  const handleAddRecord = async (formData: FormData) => {
    const parsed = parseRecordForm(formData, td);
    if ('error' in parsed) {
      toast.error(parsed.error);
      return;
    }
    try {
      await createDnsRecord.mutateAsync({ domainId: domain.id, data: parsed });
      setShowAddRecord(false);
      toast.success(td.dnsRecordAdded);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : td.failedToAddRecord);
    }
  };

  const handleUpdateRecord = useCallback(async (recordId: string, formData: FormData) => {
    const parsed = parseRecordForm(formData, td);
    if ('error' in parsed) {
      toast.error(parsed.error);
      return;
    }
    try {
      await updateDnsRecord.mutateAsync({ id: recordId, domainId: domain.id, data: parsed });
      setEditingRecordId(null);
      toast.success(td.dnsRecordUpdated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : td.failedToUpdateRecord);
    }
  }, [td, domain.id, updateDnsRecord]);

  const handleDeleteRecord = useCallback(async (record: HostDnsRecord) => {
    if (!window.confirm(td.deleteConfirm.replace('{type}', record.type).replace('{name}', record.name))) return;
    try {
      await deleteDnsRecord.mutateAsync({ id: record.id, domainId: domain.id });
      toast.success(td.dnsRecordDeleted);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : td.failedToDeleteRecord);
    }
  }, [td, domain.id, deleteDnsRecord]);

  const tabs: PageTab[] = [
    { id: 'dns', label: td.dnsRecords, icon: ListCollapse, count: dnsRecords.length },
    { id: 'nameservers', label: td.nameservers, icon: Server },
    { id: 'settings', label: td.settings, icon: SettingsIcon },
  ];

  // ---- EntityList config for the DNS records tab ----
  const dnsHeaderColumns: HeaderColumn[] = useMemo(() => [
    { id: 'type', header: td.type, width: 'w-[80px]' },
    { id: 'name', header: td.name, width: 'flex-1 min-w-0' },
    { id: 'value', header: td.value, width: 'flex-1 min-w-0' },
    { id: 'ttl', header: td.ttl, width: 'w-[80px]' },
    { id: 'status', header: td.status, width: 'w-[160px]' },
  ], [td]);

  const dnsFilterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'type',
      label: td.filterType,
      options: DNS_RECORD_TYPES.map((type) => ({ value: type, label: type })),
    },
    {
      field: 'lock',
      label: td.filterLock,
      options: [
        { value: 'locked', label: td.filterLocked },
        { value: 'unlocked', label: td.filterUnlocked },
      ],
    },
  ], [td]);

  const dnsApplyFilters = useCallback((items: HostDnsRecord[], active: ActiveFilter[]) => {
    let result = items;
    for (const f of active) {
      if (!f.operator || !f.value) continue;
      if (f.field === 'type') {
        result = f.operator === 'is'
          ? result.filter((r) => r.type === f.value)
          : result.filter((r) => r.type !== f.value);
      } else if (f.field === 'lock') {
        const wantLocked = f.value === 'locked';
        result = result.filter((r) => isDnsRecordLocked(r) === wantLocked);
      }
    }
    return result;
  }, []);

  const renderDnsRow = useCallback((record: HostDnsRecord) => {
    if (editingRecordId === record.id) {
      return (
        <form
          key={record.id}
          onSubmit={(e) => { e.preventDefault(); void handleUpdateRecord(record.id, new FormData(e.currentTarget)); }}
          className="p-4 bg-muted/30 space-y-4 border-b border-border/70"
        >
          <div className="grid gap-4 md:grid-cols-5">
            <div className="space-y-2">
              <Label>{td.type}</Label>
              <Select name="type" defaultValue={record.type}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DNS_RECORD_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{td.name}</Label>
              <Input name="name" defaultValue={record.name} required />
            </div>
            <div className="space-y-2">
              <Label>{td.value}</Label>
              <Input name="value" defaultValue={record.value} required />
            </div>
            <div className="space-y-2">
              <Label>{td.ttl}</Label>
              <Input name="ttl" type="number" defaultValue={record.ttl} />
            </div>
            <div className="space-y-2">
              <Label>{td.priority}</Label>
              <Input name="priority" type="number" defaultValue={record.priority ?? ''} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingRecordId(null)}>
              {td.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={updateDnsRecord.isPending}>
              {updateDnsRecord.isPending ? td.saving : td.save}
            </Button>
          </div>
        </form>
      );
    }

    const locks = getDnsRecordLocks(record);
    const locked = locks.length > 0;
    const lockReasons = locks.map((l) => l.reason);
    const lockTooltip = lockReasons.join('\n\n');
    // Locks are system-managed only (added when other modules depend on the
    // record). Users can never lock or unlock from the UI — they only see
    // the protection and the reason.
    const primarySystemLock = locks.find((l) => l.source !== 'user');
    const lockBadgeLabel =
      primarySystemLock?.source === 'weldmail' ? td.usedByEmail :
      primarySystemLock ? td.usedBy.replace('{source}', primarySystemLock.source) :
      td.filterLocked;

    return (
      <div
        key={record.id}
        className="flex items-center gap-4 px-4 py-3 border-b border-border/70 group hover:bg-muted/50"
      >
        {/* Type */}
        <div className="w-[80px] flex-shrink-0">
          <Badge variant="outline" className="font-mono text-xs min-w-[60px] justify-center">
            {record.type}
          </Badge>
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium font-mono text-foreground truncate">{record.name}</span>
            {locked && (
              <span
                className={cn(
                  PILL,
                  'gap-1 flex-shrink-0 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950',
                )}
                title={lockTooltip}
              >
                <Lock className="h-3 w-3" />
                {lockBadgeLabel}
              </span>
            )}
          </div>
          {locked && (
            <p className="text-xs text-muted-foreground mt-1 truncate">{lockReasons[0]}</p>
          )}
        </div>

        {/* Value */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-muted-foreground font-mono truncate block">{record.value}</span>
          {record.priority !== null && record.priority !== undefined && (
            <span className="text-xs text-muted-foreground">{td.priority}: {record.priority}</span>
          )}
        </div>

        {/* TTL */}
        <div className="w-[80px] flex-shrink-0 text-sm text-muted-foreground">{record.ttl}s</div>

        {/* Actions */}
        <div className="w-[160px] flex-shrink-0 flex items-center justify-end gap-1">
          {canManageDns && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => { setShowAddRecord(false); setEditingRecordId(record.id); }}
                disabled={locked || updateDnsRecord.isPending || deleteDnsRecord.isPending}
                title={locked ? lockTooltip : undefined}
              >
                {td.edit}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => void handleDeleteRecord(record)}
                disabled={locked || deleteDnsRecord.isPending}
                title={locked ? lockTooltip : undefined}
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }, [
    editingRecordId,
    canManageDns,
    updateDnsRecord.isPending,
    deleteDnsRecord.isPending,
    handleUpdateRecord,
    handleDeleteRecord,
    td,
  ]);

  return (
    <div className="flex flex-col h-full">
      {/* Header — mirrors /crm/customers/[id] page-mode header exactly */}
      <div className="flex flex-col bg-background">
        <div className="group/header flex items-center justify-between px-3 md:px-4 py-[12.5px] flex-shrink-0">
          {/* Left Section */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Mobile back button */}
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden p-1.5 -ml-1 hover:bg-muted rounded-md transition-colors flex-shrink-0"
                onClick={onClose}
                aria-label={td.backToList}
              >
                <X className="h-5 w-5 text-muted-foreground" />
              </Button>
            )}
            <div className="flex items-center gap-2 min-w-0">
              <div className="relative w-7 h-7 rounded-lg flex-shrink-0 overflow-hidden">
                <div className="w-full h-full rounded-lg flex items-center justify-center bg-blue-100 dark:bg-blue-900">
                  <Globe className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
              <h1 className="text-sm md:text-lg font-medium text-foreground truncate">
                {domainName}
              </h1>
              <span className={cn(PILL, status.color, 'shrink-0')}>{status.label}</span>
            </div>
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={() => copyToClipboard(domainName)}
              title={td.copyDomain}
            >
              <Copy className="h-4 w-4 text-gray-500" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={() => window.open(`https://${domainName}`, '_blank')}
              title={td.visitDomain}
            >
              <ExternalLink className="h-4 w-4 text-gray-500" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              title={td.moreActions}
              aria-label={td.moreActions}
            >
              <EllipsisVertical className="h-4 w-4 text-gray-500" />
            </Button>
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-muted rounded-md transition-colors"
                onClick={onClose}
                title={td.close}
                aria-label={td.close}
              >
                <X className="h-4 w-4 text-gray-500" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Body — main column with tabs + content + 750px sidebar */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: tabs and content */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Tabs */}
          <div className="relative z-10">
            <PageTabs
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(id) => setActiveTab(id as typeof activeTab)}
              innerClassName="px-4 pt-1"
            />
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="p-6 max-w-[960px]">
              {/* DNS Records Tab — uses the same EntityList component as the
                  domains list page and the customer-detail sub-tabs. */}
              {activeTab === 'dns' && (
                <div className="space-y-3">
                  {/* Add DNS Record Form (inline above the list) */}
                  {showAddRecord && (
                    <form
                      onSubmit={(e) => { e.preventDefault(); void handleAddRecord(new FormData(e.currentTarget)); }}
                      className="p-4 rounded-lg border bg-card space-y-4"
                    >
                      <div className="grid gap-4 md:grid-cols-5">
                        <div className="space-y-2">
                          <Label>{td.type}</Label>
                          <Select name="type" defaultValue="A">
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {DNS_RECORD_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>{td.name}</Label>
                          <Input name="name" placeholder={domain.fullDomain || '@'} required />
                        </div>
                        <div className="space-y-2">
                          <Label>{td.value}</Label>
                          <Input name="value" placeholder={td.ipOrHostname} required />
                        </div>
                        <div className="space-y-2">
                          <Label>{td.ttl}</Label>
                          <Input name="ttl" type="number" defaultValue="3600" />
                        </div>
                        <div className="space-y-2">
                          <Label>{td.priority}</Label>
                          <Input name="priority" type="number" placeholder="10" />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={() => setShowAddRecord(false)}>
                          {td.cancel}
                        </Button>
                        <Button type="submit" disabled={createDnsRecord.isPending}>
                          {createDnsRecord.isPending ? td.adding : td.addRecord}
                        </Button>
                      </div>
                    </form>
                  )}

                  <EntityList<HostDnsRecord>
                    items={dnsRecords}
                    isLoading={false}
                    error={null}
                    headerColumns={dnsHeaderColumns}
                    filters={dnsFilterConfigs}
                    maxFilters={3}
                    applyFilters={dnsApplyFilters}
                    renderRow={renderDnsRow}
                    searchPlaceholder={td.searchDnsRecords}
                    searchFields={['name', 'value', 'type']}
                    emptyStateClassName="pb-24"
                    createButton={
                      canManageDns
                        ? {
                            label: td.addRecord,
                            onClick: () => { setEditingRecordId(null); setShowAddRecord(true); },
                          }
                        : undefined
                    }
                    emptyState={{
                      icon: (
                        <EmptyStateIllustration>
                          <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="22" y="32" width="76" height="14" rx="3" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                            <rect x="22" y="52" width="76" height="14" rx="3" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                            <rect x="22" y="72" width="76" height="14" rx="3" className="fill-white dark:fill-white/[0.03] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                            <circle cx="32" cy="39" r="2.5" className="fill-gray-300 dark:fill-white/30" />
                            <circle cx="32" cy="59" r="2.5" className="fill-gray-300 dark:fill-white/30" />
                            <circle cx="32" cy="79" r="2.5" className="fill-gray-300 dark:fill-white/30" />
                          </svg>
                        </EmptyStateIllustration>
                      ),
                      title: td.noDnsRecordsTitle,
                      description: canManageDns
                        ? td.noDnsRecordsDescription
                        : td.noDnsRecordsNoZone,
                      action: canManageDns
                        ? { label: td.addRecord, onClick: () => { setEditingRecordId(null); setShowAddRecord(true); } }
                        : undefined,
                    }}
                    noResultsState={{
                      title: td.noMatchingRecordsTitle,
                      description: td.noMatchingRecordsDescription,
                    }}
                  />
                </div>
              )}

              {/* Nameservers Tab */}
              {activeTab === 'nameservers' && (
                <div className="space-y-6">
                  {nameservers.length === 0 ? (
                    <div className="p-4 rounded-lg border border-yellow-200 bg-yellow-50">
                      <div className="flex gap-3">
                        <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0 mt-1" />
                        <div>
                          <p className="font-medium text-yellow-900">{td.noNameserversTitle}</p>
                          <p className="text-sm text-yellow-800 mt-1">
                            {td.noNameserversDescription}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 rounded-lg border bg-muted/30">
                        <div className="flex gap-3">
                          <Server className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                          <div className="space-y-1">
                            <p className="font-medium">{td.nameserversTitle}</p>
                            <p className="text-sm text-muted-foreground">
                              {isExternalDomain
                                ? td.nameserversExternal
                                    .replace('{registrar}', domain.registrar || 'your registrar')
                                    .replace('{domain}', domainName)
                                : td.nameserversAuthoritative}
                            </p>
                            {zoneStatus && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {td.zoneStatus}{' '}
                                <span className="font-medium capitalize">{zoneStatus}</span>
                                {zoneStatus === 'pending' && ` ${td.zonePending}`}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <p className="text-sm font-medium text-muted-foreground">{td.nameservers}</p>
                        <div className="border rounded-lg divide-y">
                          {nameservers.map((ns, index) => (
                            <div key={ns} className="flex items-center justify-between p-4">
                              <div className="flex items-center gap-4">
                                <span className="text-sm text-muted-foreground w-8">
                                  NS{index + 1}
                                </span>
                                <code className="font-mono text-sm font-medium">{ns}</code>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => copyToClipboard(ns)}
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>

                      {isExternalDomain && (
                        <p className="text-sm text-muted-foreground text-center">
                          {td.nameserversPropagated}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Settings Tab */}
              {activeTab === 'settings' && (
                <div className="space-y-6">
                  <form onSubmit={handleSaveSettings} className="space-y-6">
                    <div className="flex items-center justify-between p-4 rounded-lg border">
                      <div>
                        <p className="font-medium">{td.autoRenewalTitle}</p>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {isExternalDomain
                            ? td.autoRenewalNotAvailable
                            : td.autoRenewalDescription}
                        </p>
                      </div>
                      <Switch
                        checked={autoRenew}
                        onCheckedChange={setAutoRenew}
                        disabled={isExternalDomain}
                      />
                    </div>

                    {!isExternalDomain && (
                      <div className="flex justify-end">
                        <Button type="submit" disabled={toggleAutoRenewMutation.isPending}>
                          {toggleAutoRenewMutation.isPending ? td.saving : td.saveSettings}
                        </Button>
                      </div>
                    )}
                  </form>

                  {!isExternalDomain && !autoRenew && domain.expiresAt && (
                    <div className="p-4 rounded-lg border border-yellow-200 bg-yellow-50">
                      <div className="flex gap-3">
                        <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-medium text-yellow-900">{td.autoRenewalDisabledTitle}</p>
                          <p className="text-sm text-yellow-800 mt-1">
                            {td.autoRenewalDisabledDescription.replace('{date}', new Date(domain.expiresAt).toLocaleDateString())}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Sidebar — 750px, mirrors /crm/customers/[id] sidebar exactly */}
        <div className="w-[750px] flex-shrink-0 bg-background flex flex-col">
          <div>
            <PageTabs
              tabs={[{ id: 'details', label: td.details, icon: ListCollapse }]}
              activeTab="details"
              innerClassName="px-4 pt-1"
            />
          </div>
          <div className="flex-1 min-h-0 border-l border-border overflow-y-auto">
            <div className="p-4">
              <DomainSidebarDetails domain={domain} dnsZone={dnsZone} td={td} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Sidebar — sections + field rows that match the /crm/customers/[id] sidebar
// design exactly: section header (text-sm font-medium), space-y-3 within a
// section, flex items-center gap-3 for each row, dividers via
// `pt-4 border-t border-border` between sections.
// ============================================================================

function fmtDate(value: string | undefined | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysUntil(value: string | undefined | null): number | null {
  if (!value) return null;
  return Math.floor((new Date(value).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function StatusPill({ kind, children }: { kind: 'ok' | 'warn' | 'err' | 'muted'; children: React.ReactNode }) {
  const cls =
    kind === 'ok' ? 'bg-green-100 text-green-700 dark:bg-emerald-950 dark:text-emerald-300' :
    kind === 'warn' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' :
    kind === 'err' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' :
    'bg-muted text-foreground';
  return <span className={cn('text-xs px-2 py-0.5 rounded-full', cls)}>{children}</span>;
}

function YesNo({ enabled, td }: { enabled: boolean; td: CommonTranslations }) {
  return enabled
    ? <StatusPill kind="ok">{td.enabled}</StatusPill>
    : <StatusPill kind="muted">{td.disabled}</StatusPill>;
}

type DomainDetailTranslations = ReturnType<typeof useI18n>['t']['host']['domainDetail'];
type CommonTranslations = ReturnType<typeof useI18n>['t']['host']['common'];

function DomainSidebarDetails({
  domain,
  dnsZone,
  td,
}: {
  domain: Domain;
  dnsZone?: DnsZone | null;
  td: DomainDetailTranslations;
}) {
  const { t } = useI18n();
  const tc = t.host.common;

  const fullDomain = domain.fullDomain || `${domain.name}.${domain.tld}`;
  const days = daysUntil(domain.expiresAt);
  const statusKind: 'ok' | 'warn' | 'err' | 'muted' =
    domain.status === 'active' ? 'ok' :
    domain.status === 'pending' ? 'warn' :
    domain.status === 'expired' || domain.status === 'suspended' ? 'err' :
    'muted';

  const nameservers: string[] =
    (Array.isArray(domain.nameservers) && domain.nameservers.length > 0
      ? domain.nameservers
      : (dnsZone?.externalNameservers as string[] | undefined)) || [];

  const contactRow = (label: string, contact: DomainContact | null | undefined) => {
    if (!contact?.email) return null;
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
    return (
      <div className="flex items-start gap-3">
        <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{label}</span>
        <div className="text-sm text-foreground min-w-0">
          {name && <div className="truncate">{name}</div>}
          <div className="text-blue-600 hover:underline truncate">
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Domain Information */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{td.domainInformation}</h3>
        <div className="flex items-center gap-3">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-foreground font-mono truncate">{fullDomain}</span>
        </div>
        <div className="flex items-center gap-3">
          <Tag className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-foreground">.{domain.tld}</span>
        </div>
        <div className="flex items-center gap-3">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-foreground">{domain.registrar || 'WeldHost'}</span>
        </div>
      </div>

      {/* Status */}
      <div className="space-y-3 pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-foreground">{td.statusSection}</h3>
        <div className="flex items-center gap-3">
          <CircleDot className="h-4 w-4 text-muted-foreground" />
          <StatusPill kind={statusKind}>{domain.status}</StatusPill>
        </div>
        {days !== null && (
          <div className="flex items-center gap-3">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {days < 0 ? (
              <StatusPill kind="err">{td.expiredDaysAgo.replace('{days}', String(Math.abs(days)))}</StatusPill>
            ) : days < 30 ? (
              <StatusPill kind="warn">{td.daysLeft.replace('{days}', String(days))}</StatusPill>
            ) : (
              <span className="text-sm text-foreground">{td.daysRemaining.replace('{days}', String(days))}</span>
            )}
          </div>
        )}
        {dnsZone?.status && (
          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.zone}</span>
            <span className="text-sm text-foreground capitalize">{dnsZone.status}</span>
          </div>
        )}
        {dnsZone?.provider && (
          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.provider}</span>
            <span className="text-sm text-foreground capitalize">{dnsZone.provider}</span>
          </div>
        )}
      </div>

      {/* Important Dates */}
      {(domain.registeredAt || domain.expiresAt || domain.renewedAt || domain.createdAt) && (
        <div className="space-y-3 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{td.importantDates}</h3>
          {domain.registeredAt && (
            <div className="flex items-start gap-3">
              <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.registered}</span>
              <span className="text-sm text-foreground">{fmtDate(domain.registeredAt)}</span>
            </div>
          )}
          {domain.expiresAt && (
            <div className="flex items-start gap-3">
              <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.expires}</span>
              <span className="text-sm text-foreground">{fmtDate(domain.expiresAt)}</span>
            </div>
          )}
          {domain.renewedAt && (
            <div className="flex items-start gap-3">
              <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.renewed}</span>
              <span className="text-sm text-foreground">{fmtDate(domain.renewedAt)}</span>
            </div>
          )}
          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.created}</span>
            <span className="text-sm text-foreground">{fmtDate(domain.createdAt)}</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.updated}</span>
            <span className="text-sm text-foreground">{fmtDate(domain.updatedAt)}</span>
          </div>
        </div>
      )}

      {/* Settings */}
      <div className="space-y-3 pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-foreground">{td.settingsSection}</h3>
        <div className="flex items-center gap-3">
          <RefreshCcw className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground w-32">{td.autoRenew}</span>
          <YesNo enabled={!!domain.autoRenew} td={tc} />
        </div>
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground w-32">{td.ssl}</span>
          <YesNo enabled={!!domain.sslEnabled} td={tc} />
        </div>
        <div className="flex items-center gap-3">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground w-32">{td.emailForwarding}</span>
          <YesNo enabled={!!domain.emailForwardingEnabled} td={tc} />
        </div>
        <div className="flex items-center gap-3">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground w-32">{td.privacyProtection}</span>
          <YesNo enabled={!!domain.privacyProtection} td={tc} />
        </div>
        <div className="flex items-center gap-3">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground w-32">{td.transferLock}</span>
          <YesNo enabled={!!domain.locked} td={tc} />
        </div>
      </div>

      {/* Nameservers */}
      {nameservers.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{td.nameserversSection}</h3>
          {nameservers.map((ns, i) => (
            <div key={ns} className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground w-8 flex-shrink-0">NS{i + 1}</span>
              <code className="text-sm text-foreground font-mono truncate">{ns}</code>
            </div>
          ))}
        </div>
      )}

      {/* Contacts */}
      {((domain.registrantContact as DomainContact | null)?.email ||
        (domain.adminContact as DomainContact | null)?.email ||
        (domain.techContact as DomainContact | null)?.email ||
        (domain.billingContact as DomainContact | null)?.email) && (
        <div className="space-y-3 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{td.contactsSection}</h3>
          {contactRow(td.registrant, domain.registrantContact as DomainContact | null)}
          {contactRow(td.admin, domain.adminContact as DomainContact | null)}
          {contactRow(td.technical, domain.techContact as DomainContact | null)}
          {contactRow(td.billing, domain.billingContact as DomainContact | null)}
        </div>
      )}

      {/* Identifiers */}
      <div className="space-y-3 pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-foreground">{td.identifiers}</h3>
        <div className="flex items-start gap-3">
          <span className="text-sm text-muted-foreground w-24 flex-shrink-0">{td.domainId}</span>
          <code className="text-xs text-muted-foreground font-mono break-all">{domain.id}</code>
        </div>
      </div>

      {/* Notes */}
      {domain.notes && (
        <div className="space-y-3 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{td.notesSection}</h3>
          <p className="text-sm text-foreground whitespace-pre-wrap">{domain.notes}</p>
        </div>
      )}
    </div>
  );
}
