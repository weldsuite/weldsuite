import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useUpdateReachSettings } from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { warmupCopyParams } from '../lib/warmup';
import { StepFooter, StepFrame } from './setup-shell';

export function DoneStep({
  domainCount,
  mailboxCount,
  canFinish,
  onBack,
  onFinished,
}: Readonly<{
  domainCount: number;
  mailboxCount: number;
  canFinish: boolean;
  onBack: () => void;
  onFinished: () => void;
}>) {
  const t = useTranslations();
  const update = useUpdateReachSettings();

  const finish = async () => {
    try {
      await update.mutateAsync({ completeOnboarding: true });
      onFinished();
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  };

  return (
    <StepFrame
      title={t('reach.setup.done.title')}
      description={t('reach.setup.done.description', warmupCopyParams())}
    >
      <ul className="space-y-2 text-sm">
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {t('reach.setup.done.summaryDomains', { count: domainCount })}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {t('reach.setup.done.summaryMailboxes', { count: mailboxCount })}
        </li>
      </ul>

      {mailboxCount === 0 && <InfoBanner variant="warning">{t('reach.setup.done.noMailboxesWarning')}</InfoBanner>}

      <StepFooter
        onBack={onBack}
        onNext={() => void finish()}
        nextDisabled={!canFinish}
        nextBusy={update.isPending}
        nextLabel={update.isPending ? t('reach.setup.done.finishing') : t('reach.setup.done.finish')}
      />
    </StepFrame>
  );
}
