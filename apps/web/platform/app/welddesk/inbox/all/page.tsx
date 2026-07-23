
import React from 'react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

export default function AllInboxesPage() {
  const { t } = useI18n();
  const ip = t.helpdesk.inboxPages;

  return (
    <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Speech bubble */}
          <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="fill-white dark:fill-white/[0.03]" />
          <path d="M30 24h62a8 8 0 018 8v36a8 8 0 01-8 8H52l-10 10v-10h-12a8 8 0 01-8-8V32a8 8 0 018-8z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          {/* Text lines */}
          <rect x="34" y="40" width="52" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="34" y="48" width="38" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="34" y="56" width="24" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.selectConversationTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.selectConversationDesc}</p>
    </div>
  );
}
