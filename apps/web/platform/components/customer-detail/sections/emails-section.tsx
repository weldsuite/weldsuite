
import { Mail } from 'lucide-react';
import { EntityList, EmptyStateIllustration } from '@/components/entity-list';
import { useCustomerDetailContext } from '../customer-detail-provider';
import { useComposeSafe } from '@/contexts/compose-context';
import type { EmailsSectionProps } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

// Placeholder type for emails
interface EmailItem {
  id: string;
  subject: string;
}

export function EmailsSection({ customer }: EmailsSectionProps) {
  const t = useTranslations();
  const { onCompose } = useCustomerDetailContext();
  const composeContext = useComposeSafe();

  const handleCompose = () => {
    if (customer.email && onCompose) {
      onCompose(customer.email);
    } else if (customer.email && composeContext?.openCompose) {
      composeContext.openCompose({ to: customer.email });
    } else if (customer.email) {
      window.location.href = `mailto:${customer.email}`;
    }
  };

  return (
    <EntityList<EmailItem>
      items={[]}
      isLoading={false}
      error={null}
      filters={[]}
      maxFilters={0}
      searchPlaceholder={t('sweep.weldcrm.emailsSection.searchEmails')}
      searchFields={['subject']}
      emptyStateClassName="pb-24"
      createButton={{
        label: t('sweep.weldcrm.emailsSection.compose'),
        onClick: handleCompose,
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Envelope body */}
              <rect x="20" y="35" width="80" height="55" rx="4" className="fill-white dark:fill-white/[0.03]" />
              <rect x="20" y="35" width="80" height="55" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
              {/* Bottom V fold lines */}
              <path d="M20 90L52 65" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
              <path d="M100 90L68 65" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
              {/* Envelope flap background */}
              <path d="M20.5 38C20.5 36.3 21.8 35 23.5 35H96.5C98.2 35 99.5 36.3 99.5 38L60 64Z" className="fill-gray-50 dark:fill-white/[0.06]" />
              {/* Envelope flap stroke */}
              <path d="M20 35L60 64L100 35" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: t('sweep.weldcrm.emailsSection.noEmailsYet'),
        description: t('sweep.weldcrm.emailsSection.noEmailsYetDescription'),
        action: {
          label: t('sweep.weldcrm.emailsSection.compose'),
          onClick: handleCompose,
        },
      }}
      noResultsState={{
        title: t('sweep.weldcrm.emailsSection.noEmailsFound'),
        description: t('sweep.weldcrm.emailsSection.noEmailsFoundDescription'),
      }}
    />
  );
}
