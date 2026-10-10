import { AlertCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * Shown when a CRM list's first fetch failed. Without it a failed request fell
 * through to the empty state ("No companies yet"), which reads as "you have no
 * data" instead of "we could not load it".
 */
export function ListLoadError({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 px-6 py-16 text-center"
    >
      <AlertCircle className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground max-w-[320px]">{t('crm.listPage.loadFailed')}</p>
      <Button variant="outline" className="h-8 text-sm shadow-none" onClick={onRetry}>
        {t('crm.listPage.retry')}
      </Button>
    </div>
  );
}
