
import { useSearchParams } from '@/lib/router';
import { useHelpdeskContacts } from '@/hooks/queries/use-helpdesk-queries';
import { CustomersGrid } from './customers-grid';
import { PageLoader } from '@/components/page-loader';

export default function CustomersPage() {
  const searchParams = useSearchParams();
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;
  const search = searchParams.get('search') || undefined;

  const currentParams: Record<string, string> = {};
  searchParams.forEach((value: string, key: string) => {
    currentParams[key] = value;
  });

  const { data, isLoading } = useHelpdeskContacts({
    page,
    pageSize: 25,
    search,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  const items = data?.data || [];
  const pagination = data?.pagination || { page: 1, pageSize: 25, totalCount: 0, totalPages: 0 };

  return (
    <CustomersGrid
      customers={items}
      pagination={{
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalCount: pagination.totalCount,
        totalPages: pagination.totalPages,
      }}
      searchParams={currentParams}
    />
  );
}
