import { EmptyStateIllustration } from '@/components/entity-list';
import { getTranslations } from '@/lib/i18n';

export function EmptyConversationPane() {
  const t = getTranslations('deskInbox2');
  return (
    <div className="h-full hidden md:flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="22" y="28" width="76" height="64" rx="8" className="fill-white dark:fill-secondary" />
          <rect x="22" y="28" width="76" height="64" rx="8" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
          <path d="M36 48H84" className="stroke-gray-100 dark:stroke-border" strokeWidth="4" strokeLinecap="round" />
          <path d="M36 60H72" className="stroke-gray-100 dark:stroke-border" strokeWidth="4" strokeLinecap="round" />
          <path d="M36 72H60" className="stroke-gray-100 dark:stroke-border" strokeWidth="4" strokeLinecap="round" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{t.pane.selectTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{t.pane.selectDescription}</p>
    </div>
  );
}
