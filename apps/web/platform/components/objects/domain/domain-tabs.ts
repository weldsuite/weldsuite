import { LayoutGrid, ListCollapse, Server, Settings, History } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the domain panel.
 *
 * Deliberately NOT the CRM default set from `simple-object-panel.tsx` — a
 * domain has no emails, calls or deals. Every tab here is backed by a real
 * endpoint:
 *
 *   overview     → `/api/domains/:id`                  (the registry record)
 *   dns          → `/api/dns-records/by-domain/:id`    (full CRUD via Cloudflare)
 *   nameservers  → domain.nameservers + `/api/dns-zones/by-domain/:id`
 *   settings     → `/api/domains/:id/auto-renew`
 *   history      → `/api/audit-logs?entityType=domain`
 */
export interface DomainTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'dns' | 'nameservers' | 'settings' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getDomainTabs(labels: {
  details: string;
  dns: string;
  nameservers: string;
  settings: string;
  history: string;
  dnsCount?: number;
}): DomainTab[] {
  return [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'dns',
      label: labels.dns,
      icon: ListCollapse,
      count: labels.dnsCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'nameservers',
      label: labels.nameservers,
      icon: Server,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'settings',
      label: labels.settings,
      icon: Settings,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInFullscreen: true,
    },
  ];
}
