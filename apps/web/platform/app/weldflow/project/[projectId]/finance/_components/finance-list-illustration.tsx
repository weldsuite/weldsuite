import { EmptyStateIllustration } from '@/components/entity-list';

/** The empty state of the finance lists: a sheet of cost lines with their amounts. */
export function FinanceListIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <rect x="18" y="12" width="84" height="96" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="18" y="12" width="84" height="96" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <line x1="30" y1="34" x2="62" y2="34" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.6" />
        <line x1="76" y1="34" x2="90" y2="34" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.6" />
        <line x1="30" y1="50" x2="56" y2="50" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.5" />
        <line x1="76" y1="50" x2="90" y2="50" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.5" />
        <line x1="30" y1="66" x2="60" y2="66" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.4" />
        <line x1="76" y1="66" x2="90" y2="66" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.4" />
        <line x1="30" y1="84" x2="90" y2="84" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <line x1="70" y1="94" x2="90" y2="94" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="2" opacity="0.6" />
      </svg>
    </EmptyStateIllustration>
  );
}
