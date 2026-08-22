'use client';

import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { hostKeys, type HostDnsRecord } from '@/hooks/queries/use-host-queries';
import { previewDomain, previewDnsZone } from './fixtures';

/** Preload WeldHost react-query cache so DomainPanel renders fixture data offline. */
export function useSeedPreviewHostData(records: HostDnsRecord[]) {
  const queryClient = useQueryClient();
  const domainId = previewDomain.id;

  useLayoutEffect(() => {
    const infinite = { staleTime: Infinity, gcTime: Infinity };

    queryClient.setQueryDefaults(hostKeys.domain(domainId), infinite);
    queryClient.setQueryDefaults(hostKeys.dnsZones(domainId), infinite);
    queryClient.setQueryDefaults(hostKeys.dnsRecords(domainId), infinite);

    queryClient.setQueryData(hostKeys.domain(domainId), { data: previewDomain });
    queryClient.setQueryData(hostKeys.dnsZones(domainId), {
      success: true,
      data: previewDnsZone,
      records: [],
      templates: [],
    });
    queryClient.setQueryData(hostKeys.dnsRecords(domainId), {
      success: true,
      data: {
        records,
        zone: {
          id: previewDnsZone.id,
          syncedAt: previewDnsZone.syncedAt,
          syncError: previewDnsZone.syncError,
        },
      },
    });
    queryClient.setQueryData([...hostKeys.domain(domainId), 'zone-status'], {
      data: {
        zoneStatus: 'active',
        domainStatus: 'active',
        cloudflareStatus: 'active',
      },
    });
  }, [queryClient, records, domainId]);
}
