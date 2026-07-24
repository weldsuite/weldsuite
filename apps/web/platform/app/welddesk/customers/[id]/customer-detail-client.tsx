
import { useState } from 'react';
import { useRouter, Link } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { format } from 'date-fns';
import {
  Mail,
  Calendar,
  EllipsisVertical,
  ExternalLink,
  Copy,
  User,
  MapPin,
  Hash,
  Building,
  Phone,
  MessageSquare,
  Tag,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useUpdateHelpdeskCustomer, useHelpdeskCompanies } from '@/hooks/queries/use-helpdesk-queries';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  PersonDetailLayout,
  CompanySelectorDialog,
  TimezoneSelectorDialog,
  LanguageSelectorDialog,
  type Company,
} from '@/components/person-detail';
import { useI18n } from '@/lib/i18n/provider';

interface ConversationData {
  id: string;
  subject: string;
  preview: string;
  status: string;
  channel: string;
  createdAt: Date;
  lastMessageAt: Date;
}

interface CustomerDetailClientProps {
  customerData: {
    id: string;
    name: string;
    email: string;
    avatar: string;
    phone?: string;
    company?: string;
    location?: string;
    timezone?: string;
    language?: string;
    status: 'active' | 'inactive' | 'vip';
    tags: string[];
    lastContact: Date;
    conversationCount: number;
    totalSpent: number;
    orderCount: number;
    loyaltyTier?: string;
    conversations: ConversationData[];
  };
}

export function CustomerDetailClient({ customerData }: CustomerDetailClientProps) {
  const router = useRouter();
  const { t } = useI18n();
  const tc = t.helpdesk.customers;
  const [customer, setCustomer] = useState(customerData);
  const updateCustomerMutation = useUpdateHelpdeskCustomer();
  const { data: companiesResult, isLoading: isLoadingCompaniesQuery } = useHelpdeskCompanies();

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tc.contacts, href: '/welddesk/contacts' },
    { label: customerData.name },
  ]);
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);
  const companies: Company[] = companiesResult?.data || [];
  const isLoadingCompanies = isLoadingCompaniesQuery;
  const [timezoneDialogOpen, setTimezoneDialogOpen] = useState(false);
  const [languageDialogOpen, setLanguageDialogOpen] = useState(false);

  const handleFieldSave = async (fieldKey: string, value: string) => {
    const updateData: Record<string, string> = { [fieldKey]: value };
    const result = await updateCustomerMutation.mutateAsync({ id: customer.id, data: updateData });

    if (result.success) {
      setCustomer(prev => ({ ...prev, [fieldKey]: value }));
    }
  };

  const handleCompanySelect = async (company: Company) => {
    await handleFieldSave('company', company.name);
  };

  const handleCompanyCreate = async (name: string) => {
    await handleFieldSave('company', name);
  };

  const handleTimezoneSelect = async (timezone: { id: string; name: string }) => {
    // Update local state immediately
    setCustomer(prev => ({ ...prev, timezone: timezone.name }));
    // Try to save to API (may not be supported yet)
    try {
      await updateCustomerMutation.mutateAsync({ id: customer.id, data: { timezone: timezone.name } });
    } catch {
      // Ignore API errors for timezone for now
    }
  };

  const handleLanguageSelect = async (language: { code: string; name: string }) => {
    // Update local state immediately
    setCustomer(prev => ({ ...prev, language: language.name }));
    // Try to save to API (may not be supported yet)
    try {
      await updateCustomerMutation.mutateAsync({ id: customer.id, data: { language: language.name } });
    } catch {
      // Ignore API errors for language for now
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'open': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800';
      case 'resolved': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800';
      case 'closed': return 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border';
      default: return 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border';
    }
  };

  const getChannelBadge = (channel: string) => {
    switch (channel) {
      case 'email': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800';
      case 'chat': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800';
      case 'phone': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800';
      default: return 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border';
    }
  };

  // Conversations table component
  const ConversationsTable = () => (
    <div className="rounded-lg border border-border/60 bg-card">
      <Table>
        <TableHeader className="[&_tr]:border-border/60">
          <TableRow className="border-border/60">
            <TableHead>{tc.subject}</TableHead>
            <TableHead>{tc.preview}</TableHead>
            <TableHead>{tc.channel}</TableHead>
            <TableHead>{tc.status}</TableHead>
            <TableHead>{tc.date}</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/60">
          {customerData.conversations.length > 0 ? (
            customerData.conversations.map((conversation) => (
              <TableRow
                key={conversation.id}
                className="cursor-pointer border-border/60"
                onClick={() => router.push(`/welddesk/inbox/all/${conversation.id}`)}
              >
                <TableCell className="font-medium max-w-[200px] truncate">
                  {conversation.subject}
                </TableCell>
                <TableCell className="max-w-[250px] truncate text-muted-foreground">
                  {conversation.preview}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={getChannelBadge(conversation.channel)}>
                    {conversation.channel}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={getStatusBadge(conversation.status)}>
                    {conversation.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {format(conversation.lastMessageAt, 'MMM d, yyyy')}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/welddesk/inbox/all/${conversation.id}`} className="flex items-center">
                          <ExternalLink className="h-3.5 w-3.5 mr-2" />
                          {tc.viewConversation}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(conversation.id);
                      }}>
                        <Copy className="h-3.5 w-3.5 mr-2" />
                        {tc.copyId}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                <MessageSquare className="h-12 w-12 mx-auto mb-2 opacity-20" />
                <p>{tc.noConversationsYet}</p>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );

  // Activity component (placeholder)
  const ActivityLog = () => (
    <div className="rounded-lg border border-border/60 bg-card divide-y divide-border/60">
      <div className="flex items-start gap-3 p-4">
        <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
          <MessageSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">{tc.startedNewConversation}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{format(customerData.lastContact, 'MMM d, yyyy')}</p>
        </div>
      </div>
      <div className="flex items-start gap-3 p-4">
        <div className="h-8 w-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center flex-shrink-0">
          <User className="h-4 w-4 text-green-600 dark:text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">{tc.customerProfileCreated}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{tc.accountCreated}</p>
        </div>
      </div>
    </div>
  );

  return (
    <>
    <PersonDetailLayout
      header={{
        name: customerData.name,
        avatar: customerData.avatar,
        backUrl: '/welddesk/contacts',
        backLabel: tc.backToContacts,
        primaryAction: {
          label: tc.emailAction,
          icon: <Mail className="h-4 w-4" />,
          href: `mailto:${customerData.email}`,
        },
        dropdownItems: (
          <>
            <DropdownMenuItem onClick={() => router.push(`/welddesk/contacts/${customerData.id}/edit`)}>
              <Pencil className="h-3.5 w-3.5 mr-2" />
              {tc.editCustomerAction}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push(`/welddesk/inbox/all?customerId=${customerData.id}`)}>
              <MessageSquare className="h-3.5 w-3.5 mr-2" />
              {tc.viewAllConversations}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              {tc.deleteCustomer}
            </DropdownMenuItem>
          </>
        ),
      }}
      sidebar={{
        sections: [
          {
            fields: [
              { icon: <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.status, value: customer.status.charAt(0).toUpperCase() + customer.status.slice(1) },
              { icon: <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.email, value: customer.email },
              { icon: <Phone className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.phone, value: customer.phone || tc.notProvided },
              { icon: <Building className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.company, value: customer.company || tc.notProvided },
              { icon: <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.location, value: customer.location || tc.unknown },
              { icon: <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.id, value: customer.id.slice(0, 12) },
              { icon: <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: tc.lastContactField, value: format(customer.lastContact, 'MMM d, yyyy') },
            ],
          },
          {
            title: tc.details,
            fields: [
              { label: tc.name, value: customer.name },
              { label: tc.email, value: customer.email },
              { key: 'phone', label: tc.phone, value: customer.phone, editable: true },
              { key: 'company', label: tc.company, value: customer.company, editable: true, onEdit: () => setCompanyDialogOpen(true) },
              { key: 'location', label: tc.location, value: customer.location, editable: true },
              { key: 'timezone', label: tc.timezone, value: customer.timezone, editable: true, onEdit: () => setTimezoneDialogOpen(true) },
              { key: 'language', label: tc.language, value: customer.language, editable: true, onEdit: () => setLanguageDialogOpen(true) },
            ],
          },
          {
            title: tc.tags,
            fields: customer.tags.length > 0
              ? customer.tags.map(tag => ({
                  icon: <Tag className="h-4 w-4 text-muted-foreground flex-shrink-0" />,
                  label: tag,
                  value: '',
                }))
              : [{ label: tc.tags, editable: true }],
          },
        ],
        onFieldSave: handleFieldSave,
      }}
      content={{
        stats: [
          { label: tc.conversations, value: customerData.conversationCount },
          { label: tc.totalSpent, value: `€${customerData.totalSpent.toLocaleString()}` },
          { label: tc.orders, value: customerData.orderCount },
          { label: tc.loyalty, value: customerData.loyaltyTier || tc.none },
        ],
        tabs: [
          { id: 'conversations', label: tc.conversations, content: <ConversationsTable /> },
          { id: 'activity', label: tc.activity, content: <ActivityLog /> },
        ],
        defaultTab: 'conversations',
      }}
    />

    <CompanySelectorDialog
      open={companyDialogOpen}
      onOpenChange={setCompanyDialogOpen}
      companies={companies}
      selectedCompany={customer.company}
      onSelect={handleCompanySelect}
      onCreate={handleCompanyCreate}
      isLoading={isLoadingCompanies}
    />

    <TimezoneSelectorDialog
      open={timezoneDialogOpen}
      onOpenChange={setTimezoneDialogOpen}
      selectedTimezone={customer.timezone}
      onSelect={handleTimezoneSelect}
    />

    <LanguageSelectorDialog
      open={languageDialogOpen}
      onOpenChange={setLanguageDialogOpen}
      selectedLanguage={customer.language}
      onSelect={handleLanguageSelect}
    />
  </>
  );
}
