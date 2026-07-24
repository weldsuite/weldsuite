
import { useSearchParams } from '@/lib/router';
import { DomainsClient } from './domains-client';
import { useDomains } from '@/hooks/queries/use-host-queries';
import type { HostDomain } from '@/lib/api/domains/weldhost';

export default function DomainsPage() {
  const searchParams = useSearchParams();
  const currentPage = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;
  const status = searchParams.get('status') || undefined;
  const search = searchParams.get('search') || undefined;

  const { data } = useDomains({
    page: currentPage,
    pageSize: 10,
    search,
    status,
  });

  return <DomainsClient domains={(data?.domains ?? []) as unknown as HostDomain[]} />;
}
