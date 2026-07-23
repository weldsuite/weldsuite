
import React from 'react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

export default function ArchivedInboxPage() {
  const { t } = useI18n();
  const ip = t.helpdesk.inboxPages;

  return (
    <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Archive box lid */}
          <rect x="18" y="32" width="84" height="16" rx="4" className="fill-gray-50 dark:fill-white/[0.06]" />
          <rect x="18" y="32" width="84" height="16" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          {/* Archive box body */}
          <rect x="24" y="48" width="72" height="44" rx="4" className="fill-white dark:fill-white/[0.03]" />
          <rect x="24" y="48" width="72" height="44" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          {/* Handle slot */}
          <rect x="50" y="58" width="20" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.archivedTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.archivedDesc}</p>
    </div>
  );
}
