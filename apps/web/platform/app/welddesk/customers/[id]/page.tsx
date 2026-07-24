
import { useParams, useRouter } from '@/lib/router';
import { CustomerDetailClient } from './customer-detail-client';
import { useHelpdeskCustomer, useHelpdeskCustomerConversations } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

interface RawCustomerConversation {
  id: string;
  subject?: string;
  lastMessage?: { content?: string };
  status: string;
  channel: string;
  createdAt: string;
  lastMessageAt?: string;
}

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
  const tc = t.helpdesk.customers;
  const customerId = params.id as string;

  const { data: customerResult, isLoading: customerLoading } = useHelpdeskCustomer(customerId, !!customerId);

  const { data: conversationsResult, isLoading: conversationsLoading } = useHelpdeskCustomerConversations(customerId, 1, 10);

  const isLoading = customerLoading || conversationsLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!customerResult?.success || !customerResult?.data) {
    router.push('/welddesk/contacts');
    return null;
  }

  const customer = customerResult.data;

  // Helper function to get initials
  const getInitials = (name: string) => {
    const parts = name.split(' ');
    return parts.map(part => part.charAt(0).toUpperCase()).join('').slice(0, 2);
  };

  const customerData = {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    avatar: getInitials(customer.name),
    phone: customer.phone,
    company: customer.company,
    location: customer.location,
    status: customer.status,
    tags: customer.tags,
    lastContact: customer.lastContact,
    conversationCount: customer.conversationCount,
    totalSpent: customer.totalSpent,
    orderCount: customer.orderCount,
    loyaltyTier: customer.loyaltyTier,
    conversations: (conversationsResult?.data || []).map((conv: RawCustomerConversation) => ({
      id: conv.id,
      subject: conv.subject || tc.noSubject,
      preview: conv.lastMessage?.content || tc.noMessages,
      status: conv.status,
      channel: conv.channel,
      createdAt: new Date(conv.createdAt),
      lastMessageAt: conv.lastMessageAt ? new Date(conv.lastMessageAt) : new Date(conv.createdAt),
    })),
  };

  return <CustomerDetailClient customerData={customerData} />;
}
