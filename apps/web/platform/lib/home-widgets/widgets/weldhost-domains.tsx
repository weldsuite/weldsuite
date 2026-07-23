import { z } from 'zod';
import { Globe } from 'lucide-react';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useDomains } from '@/hooks/queries/use-host-queries';
import { useI18n } from '@/lib/i18n/provider';
import { HostCard, type DomainRow } from '@/components/home/app-cards';
import type { HomeWidgetDefinition } from '../types';

const weldhostDomainsSchema = z.object({
  maxCount: z.number().refine((n) => [5, 10, 20].includes(n)).default(10),
});
export type WeldhostDomainsSettings = z.infer<typeof weldhostDomainsSchema>;

interface ApiDomain {
  id: string;
  name?: string;
  domain?: string;
  status?: string;
  expiresAt?: string | null;
  registrar?: string;
  provider?: string;
}

function mapStatus(s: string | undefined, expiresAt: string | null | undefined): DomainRow['status'] {
  if (s === 'pending' || s === 'transferring' || s === 'pending_transfer') return 'pending';
  if (expiresAt) {
    const expiry = new Date(expiresAt).getTime();
    if (!Number.isNaN(expiry)) {
      const daysLeft = (expiry - Date.now()) / 86_400_000;
      if (daysLeft < 30) return 'expiring';
    }
  }
  return 'active';
}

function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mapDomain(api: ApiDomain): DomainRow {
  return {
    name: api.name ?? api.domain ?? '—',
    status: mapStatus(api.status, api.expiresAt),
    expires: formatExpiry(api.expiresAt),
    registrar: api.registrar ?? api.provider ?? '—',
  };
}

function Render({ settings }: { settings: WeldhostDomainsSettings }) {
  const res = useDomains({ pageSize: settings.maxCount });
  const apiRows = ((res.data as { data?: ApiDomain[] } | undefined)?.data ?? []) as ApiDomain[];
  const rows = apiRows.map(mapDomain).slice(0, settings.maxCount);
  return <HostCard rows={rows} isLoading={res.isLoading} />;
}

function SettingsForm({ value, onChange }: { value: WeldhostDomainsSettings; onChange: (next: WeldhostDomainsSettings) => void }) {
  const { t } = useI18n();
  const f = t.weldsuiteHome.fields;
  return (
    <div>
      <Label className="mb-2 block">{f.maxRows}</Label>
      <Select value={String(value.maxCount)} onValueChange={(v) => onChange({ ...value, maxCount: Number(v) })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{[5, 10, 20].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

export const weldhostDomainsWidget: HomeWidgetDefinition<WeldhostDomainsSettings> = {
  id: 'weldhost-domains',
  module: 'weldhost',
  title: 'Domains',
  description: 'Domain status + expiry',
  icon: Globe,
  schema: weldhostDomainsSchema,
  defaultSettings: weldhostDomainsSchema.parse({}),
  HomeRender: Render,
  SettingsForm,
};
