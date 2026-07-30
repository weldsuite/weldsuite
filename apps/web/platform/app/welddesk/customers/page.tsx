
import { useSearchParams } from '@/lib/router';
import { useHelpdeskContacts, type Customer } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { CustomersGrid } from './customers-grid';
import { PageLoader } from '@/components/page-loader';

function toCustomer(contact: Helpdesk.Api.Contact): Customer {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    avatar: contact.avatar,
    tags: contact.tags ?? [],
    status: 'active',
    lastContact: contact.lastContactDate ?? contact.updatedAt,
    conversationCount: contact.totalTickets ?? 0,
    totalSpent: 0,
    orderCount: 0,
  };
}

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

  const items = (data?.data || []).map(toCustomer);
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
