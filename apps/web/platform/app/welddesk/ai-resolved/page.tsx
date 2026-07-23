
import React from 'react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

export default function AiResolvedPage() {
  const { t } = useI18n();
  return (
    <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Robot head */}
          <rect x="35" y="28" width="50" height="40" rx="8" className="fill-white dark:fill-white/[0.03]" />
          <rect x="35" y="28" width="50" height="40" rx="8" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          {/* Eyes */}
          <circle cx="50" cy="48" r="4" className="fill-gray-100 dark:fill-white/15" />
          <circle cx="70" cy="48" r="4" className="fill-gray-100 dark:fill-white/15" />
          {/* Mouth */}
          <rect x="48" y="56" width="24" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          {/* Antenna */}
          <line x1="60" y1="28" x2="60" y2="20" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          <circle cx="60" cy="18" r="3" className="fill-gray-100 dark:fill-white/15" />
          {/* Checkmark */}
          <circle cx="82" cy="72" r="12" className="fill-green-50 dark:fill-green-950" />
          <path d="M76 72l4 4 8-8" className="stroke-green-500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{t.helpdesk.aiResolved.noConversationSelected}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{t.helpdesk.aiResolved.noConversationSelectedDescription}</p>
    </div>
  );
}
