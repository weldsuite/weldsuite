
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import { useCallback } from 'react';
import { DomainDetailContent } from "./domain-detail-content";
import {
  useDomain,
  useDnsZones,
  useDnsRecords,
  useRefreshZoneStatus,
} from '@/hooks/queries/use-host-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import type { Domain } from '@weldsuite/core-api-client/schemas/domains';

export default function DomainDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const id = params.id as string;
  const returnUrl = searchParams.get('returnUrl');

  const { data: domainData, isLoading: domainLoading } = useDomain(id);
  const { data: dnsData, isLoading: dnsLoading } = useDnsZones(id);

  const zone = dnsData?.data ?? null;
  const isCloudflareZone = Boolean(zone && zone.provider === 'cloudflare');
  // Only poll Cloudflare for domains that actually have a CF zone.
  useRefreshZoneStatus(id, isCloudflareZone);
  // Fetch the actual DNS records for any zone the platform has.
  const { data: recordsData } = useDnsRecords(id, !!zone);

  const handleClose = useCallback(() => {
    router.push(returnUrl || '/weldhost/domains');
  }, [router, returnUrl]);

  const isLoading = domainLoading || dnsLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Defensive fallback: some legacy responses nest the domain under `.domain`
  // instead of `.data`; the shape can't be known statically, so narrow via
  // `unknown` rather than reaching for `any`.
  const domainResponseFallback = domainData as unknown as { domain?: Domain } | undefined;
  const domain = domainData?.data ?? domainResponseFallback?.domain;
  if (!domain) {
    return <div className="flex items-center justify-center p-8 text-muted-foreground">{t.host.domainDetail.domainNotFound}</div>;
  }

  const records = recordsData?.data?.records ?? [];
  const recordsZoneMeta = recordsData?.data?.zone ?? null;

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <DomainDetailContent
        domain={domain}
        dnsZone={zone}
        dnsRecords={records}
        dnsTemplates={dnsData?.templates || []}
        zoneSyncMeta={recordsZoneMeta}
        onClose={handleClose}
      />
    </div>
  );
}
