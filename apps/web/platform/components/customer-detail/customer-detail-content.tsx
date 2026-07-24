
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useCustomerDetailContext } from './customer-detail-provider';
import { OverviewSection } from './sections/overview-section';
import { ActivitySection } from './sections/activity-section';
import { ContactsSection } from './sections/contacts-section';
import { DealsPipelineSection } from './sections/deals-pipeline-section';
import { NotesSection } from './sections/notes-section';
import { EmailsSection } from './sections/emails-section';
import { CallsSection } from './sections/calls-section';
import { TasksSection } from './sections/tasks-section';
import { MeetingsSection } from './sections/meetings-section';
import { FilesSection } from './sections/files-section';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { CustomerChatPanel } from '@/components/customer-chat/customer-chat-panel';
import { useTranslations } from '@weldsuite/i18n/client';

interface CustomerDetailContentProps {
  variant?: 'page' | 'panel' | 'embedded';
}

export function CustomerDetailContent({ variant = 'page' }: CustomerDetailContentProps) {
  const t = useTranslations();
  const { data, activeTab, isLoading, error, silentRefresh, entityType } = useCustomerDetailContext();
  const prevTabRef = useRef(activeTab);

  // Background-refresh data when switching to the activity tab
  useEffect(() => {
    if (activeTab === 'activity' && prevTabRef.current !== 'activity') {
      silentRefresh();
    }
    prevTabRef.current = activeTab;
  }, [activeTab, silentRefresh]);

  if (isLoading) {
    return null;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-red-500 mb-2">
            {entityType === 'contact'
              ? t('sweep.weldcrm.customerDetailContent.failedToLoadContact')
              : t('sweep.weldcrm.customerDetailContent.failedToLoadCustomer')}
          </p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!data?.customer) {
    return null;
  }

  const { customer, contacts, activities, opportunities, counts, lastActivity } = data;

  // Filter notes from activities
  const notes = activities.filter(a => a.type === 'note');
  const calls = activities.filter(a => a.type === 'call');

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <OverviewSection
            customer={customer}
            contacts={contacts}
            opportunities={opportunities}
            lastActivity={lastActivity}
            counts={counts}
          />
        );
      case 'activity':
        return (
          <ActivitySection
            customer={customer}
            activities={activities}
            totalCount={counts.activities}
          />
        );
      case 'contacts':
        return (
          <ContactsSection
            customer={customer}
            contacts={contacts}
            totalCount={counts.contacts}
          />
        );
      case 'deals':
        return (
          <DealsPipelineSection
            customer={customer}
            opportunities={opportunities}
          />
        );
      case 'notes':
        return (
          <NotesSection
            customer={customer}
            activities={notes}
            totalCount={counts.notes}
          />
        );
      case 'emails':
        return <EmailsSection customer={customer} />;
      case 'calls':
        return <CallsSection customer={customer} activities={calls} />;
      case 'tasks':
        return <TasksSection customer={customer} />;
      case 'meetings':
        return <MeetingsSection customer={customer} />;
      case 'files':
        return <FilesSection customer={customer} />;
      case 'audit':
        return <EntityAuditPanel entityType="customer" entityId={customer.id} />;
      case 'chat': {
        const isB2B = (customer.type ?? '').toLowerCase() === 'b2b';
        const customerName = isB2B
          ? customer.companyName || customer.tradingName || t('sweep.weldcrm.customerDetailContent.customer')
          : customer.fullName ||
            `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim() ||
            customer.companyName ||
            t('sweep.weldcrm.customerDetailContent.customer');
        return (
          <div className="h-full min-h-0 flex flex-col">
            <CustomerChatPanel
              customerId={customer.id}
              customerName={customerName}
              entityType={entityType}
              ownerId={customer.ownerId ?? null}
              accountManagerId={customer.accountManagerId ?? null}
            />
          </div>
        );
      }
      default:
        return null;
    }
  };

  const isFullBleed =
    activeTab === 'tasks' ||
    activeTab === 'files' ||
    activeTab === 'meetings' ||
    activeTab === 'calls' ||
    activeTab === 'notes' ||
    activeTab === 'deals' ||
    activeTab === 'emails' ||
    activeTab === 'activity' ||
    activeTab === 'audit' ||
    activeTab === 'chat' ||
    activeTab === 'contacts';

  // The page variant (rendered in the maximized customer detail panel) shows
  // the Details/overview tab in a centered, max-848px column to mirror the
  // team-member panel's expanded Details layout. The panel variant (the
  // collapsed sliding drawer) keeps its tighter `px-4 py-4` so content
  // doesn't waste horizontal space inside the narrow drawer.
  if (variant === 'page' && !isFullBleed && activeTab === 'overview') {
    return (
      <div className="px-4 py-10">
        <div className="w-[848px] max-w-full mx-auto">
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(isFullBleed ? '' : 'px-4 py-4', activeTab === 'chat' && 'h-full min-h-0 flex flex-col')}>
      {renderContent()}
    </div>
  );
}
