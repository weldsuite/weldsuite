
import React from 'react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

export function TicketsEmptyState() {
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;

  return (
    <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Horizontal ticket with large side notches */}
          <path d="M16 30h88a8 8 0 0 1 8 8v10a12 12 0 0 0 0 24v10a8 8 0 0 1-8 8H16a8 8 0 0 1-8-8V72a12 12 0 0 0 0-24V38a8 8 0 0 1 8-8z" className="fill-white dark:fill-white/[0.03]" />
          <path d="M16 30h88a8 8 0 0 1 8 8v10a12 12 0 0 0 0 24v10a8 8 0 0 1-8 8H16a8 8 0 0 1-8-8V72a12 12 0 0 0 0-24V38a8 8 0 0 1 8-8z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          {/* Vertical dashed perforation */}
          <line x1="71" y1="36" x2="71" y2="84" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" strokeDasharray="4 3" />
          {/* Left section - content lines */}
          <rect x="29" y="50" width="28" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="29" y="58" width="18" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
          <rect x="29" y="66" width="22" height="3" rx="1.5" className="fill-gray-100 dark:fill-white/15" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ti.selectTicket}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ti.selectTicketDescription}</p>
    </div>
  );
}
