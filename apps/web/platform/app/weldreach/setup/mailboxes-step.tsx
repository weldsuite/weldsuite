import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { WELDREACH_INBOX_CURRENCY, WELDREACH_INBOX_PRICE_CENTS } from '@weldsuite/app-api-client/schemas/reach';
import type { ReachDomain, ReachMailbox } from '@weldsuite/app-api-client/schemas/reach';
import { useReachFormat } from '@/lib/reach/format';
import { CreateMailboxForm } from '../components/create-mailbox-form';
import { MailboxStatusBadge } from '../components/status';
import { warmupCopyParams } from '../lib/warmup';
import { StepFooter, StepFrame } from './setup-shell';

export function MailboxesStep({
  domains,
  mailboxes,
  hasPaymentMethod,
  canCreate,
  onBack,
  onNext,
  onSkip,
  onGoToPayment,
}: Readonly<{
  domains: ReachDomain[];
  mailboxes: ReachMailbox[];
  hasPaymentMethod: boolean;
  canCreate: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onGoToPayment: () => void;
}>) {
  const t = useTranslations();
  const format = useReachFormat();
  const activeDomains = domains.filter((domain) => domain.status === 'active');
  const price = format.money(WELDREACH_INBOX_PRICE_CENTS, WELDREACH_INBOX_CURRENCY);
  const hasMailbox = mailboxes.length > 0;

  return (
    <StepFrame title={t('reach.setup.mailboxes.title')} description={t('reach.setup.mailboxes.description', { price, ...warmupCopyParams() })}>
      {hasMailbox && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('reach.setup.mailboxes.createdList')}</h3>
          <ul className="divide-y rounded-lg border">
            {mailboxes.map((mailbox) => (
              <li key={mailbox.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-medium">{mailbox.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {mailbox.firstName} {mailbox.lastName}
                  </p>
                </div>
                <MailboxStatusBadge status={mailbox.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {!hasPaymentMethod && (
        <InfoBanner variant="warning">
          <p>{t('reach.setup.mailboxes.needPayment')}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onGoToPayment}>
            {t('reach.setup.payment.add')}
          </Button>
        </InfoBanner>
      )}

      {activeDomains.length === 0 && <InfoBanner variant="info">{t('reach.setup.mailboxes.noDomains')}</InfoBanner>}

      {canCreate && activeDomains.length > 0 && (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-medium">
            {hasMailbox ? t('reach.setup.mailboxes.another') : t('reach.mailboxes.create.title')}
          </h3>
          <CreateMailboxForm
            domains={activeDomains}
            paymentReturnPath="/weldreach/setup"
            paymentReturnQuery={{ step: 'mailboxes' }}
          />
        </div>
      )}

      <StepFooter onBack={onBack} onNext={onNext} nextDisabled={!hasMailbox} onSkip={hasMailbox ? undefined : onSkip} />
    </StepFrame>
  );
}
