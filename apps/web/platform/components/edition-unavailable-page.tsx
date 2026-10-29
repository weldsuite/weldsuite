import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';

/**
 * What a page of a module or feature this deployment doesn't offer renders
 * instead (edition flags, 4.F3; `lib/edition-routes.ts`), so a bookmark or a
 * pasted URL never opens a page whose API answers 404.
 */
export function EditionUnavailablePage() {
  const { t } = useI18n();
  const te = t.common.edition;

  return (
    <div className="flex h-full min-h-[calc(100vh-60px)] flex-col items-center justify-center px-6 text-center">
      <EmptyStateIllustration>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="26" y="30" width="68" height="60" rx="8" className="fill-white dark:fill-white/[0.03]" />
          <rect x="26" y="30" width="68" height="60" rx="8" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          <rect x="26" y="30" width="68" height="10" rx="4" className="fill-gray-50 dark:fill-white/[0.04]" />
          <path d="M48 56l24 24M72 56L48 80" className="stroke-gray-200 dark:stroke-white/20" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </EmptyStateIllustration>
      <h3 className="mb-1.5 text-[15px] font-semibold text-foreground">{te.unavailableTitle}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{te.unavailableDescription}</p>
      <Button asChild variant="outline" className="mt-4">
        <Link href="/">{te.backHome}</Link>
      </Button>
    </div>
  );
}
