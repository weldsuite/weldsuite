/**
 * WeldReach onboarding wizard (`/weldreach/setup?step=...`):
 *   1. sender identity (the footer of every email) -> PATCH settings
 *   2. payment method for mailboxes ($5 per mailbox per month) -> Stripe Checkout
 *   3. connect a WeldHost domain (buy or bring one in WeldHost first)
 *   4. create mailboxes
 *   5. finish -> `completeOnboarding`, back to the overview
 *
 * The step lives in the URL so the browser Back button works and Stripe can
 * return to the payment step (`?step=payment&billing=done`). Without a step
 * the wizard opens on the first one that is not done yet.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import {
  useReachBilling,
  useReachDomains,
  useReachMailboxes,
  useReachSettings,
} from '@/hooks/queries/use-reach-queries';
import { DashboardPage, ErrorPanel, useReachBreadcrumbs } from '../components/page-kit';
import { warmupCopyParams } from '../lib/warmup';
import { useBillingReturn } from '../components/use-payment-method-setup';
import { DomainsStep } from './domains-step';
import { DoneStep } from './done-step';
import { IdentityStep } from './identity-step';
import { MailboxesStep } from './mailboxes-step';
import { PaymentStep } from './payment-step';
import { Stepper } from './setup-shell';
import { parseSetupStep, SETUP_STEPS, type SetupStep } from './steps';

export default function ReachSetupPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const search = useSearch({ strict: false }) as { step?: string };
  useReachBreadcrumbs({ label: t('reach.setup.title') });
  useBillingReturn();

  const canUpdateSettings = can('reach_settings:update');
  const canCreateMailboxes = can('reach_mailboxes:create');

  const settings = useReachSettings();
  const billing = useReachBilling();
  const domains = useReachDomains();
  const mailboxes = useReachMailboxes();

  const liveMailboxes = useMemo(
    () => (mailboxes.data ?? []).filter((mailbox) => mailbox.status !== 'deleted'),
    [mailboxes.data],
  );

  const completed = useMemo(() => {
    const done = new Set<SetupStep>();
    const s = settings.data;
    if (s?.senderCompanyName && s.senderAddress && s.optOutText) done.add('identity');
    if (billing.data?.hasPaymentMethod) done.add('payment');
    if ((domains.data ?? []).length > 0) done.add('domains');
    if (liveMailboxes.length > 0) done.add('mailboxes');
    if (s?.onboardingCompletedAt) done.add('done');
    return done;
  }, [settings.data, billing.data, domains.data, liveMailboxes.length]);

  const ready = Boolean(settings.data && billing.data && domains.data && mailboxes.data);
  const stepFromUrl = parseSetupStep(search.step);

  const goTo = (step: SetupStep) => void navigate({ to: '/weldreach/setup', search: { step } });

  // No step in the URL: open on the first step that is not done, once.
  const opened = useRef(false);
  useEffect(() => {
    if (stepFromUrl || !ready || opened.current) return;
    opened.current = true;
    const next = SETUP_STEPS.find((step) => !completed.has(step)) ?? 'done';
    void navigate({ to: '/weldreach/setup', search: { step: next }, replace: true });
  }, [stepFromUrl, ready, completed, navigate]);

  const loadError = settings.isError || billing.isError || domains.isError || mailboxes.isError;
  if (loadError) {
    return (
      <DashboardPage title={t('reach.setup.title')}>
        <ErrorPanel
          onRetry={() => {
            void settings.refetch();
            void billing.refetch();
            void domains.refetch();
            void mailboxes.refetch();
          }}
        />
      </DashboardPage>
    );
  }
  if (!ready || !stepFromUrl || !settings.data || !billing.data || !domains.data) {
    return <PageLoader fullScreen={false} label={t('reach.common.loading')} />;
  }

  const index = SETUP_STEPS.indexOf(stepFromUrl);
  const previous = SETUP_STEPS[index - 1];
  const next = SETUP_STEPS[index + 1];
  const back = previous ? () => goTo(previous) : undefined;
  const forward = next ? () => goTo(next) : undefined;

  return (
    <DashboardPage
      title={t('reach.setup.title')}
      description={t('reach.setup.description', warmupCopyParams())}
      className="max-w-4xl"
    >
      <Stepper current={stepFromUrl} completed={completed} onSelect={(step) => goTo(step)} />

      <Card className="py-0">
        <CardContent className="p-5 sm:p-6">
          {stepFromUrl === 'identity' && (
            <IdentityStep settings={settings.data} canUpdate={canUpdateSettings} onDone={() => forward?.()} />
          )}
          {stepFromUrl === 'payment' && back && forward && (
            <PaymentStep
              billing={billing.data}
              canUpdate={canUpdateSettings}
              onBack={back}
              onNext={forward}
              onSkip={forward}
            />
          )}
          {stepFromUrl === 'domains' && back && forward && (
            <DomainsStep
              domains={domains.data}
              canConnect={canCreateMailboxes}
              onBack={back}
              onNext={forward}
              onSkip={forward}
            />
          )}
          {stepFromUrl === 'mailboxes' && back && forward && (
            <MailboxesStep
              domains={domains.data}
              mailboxes={liveMailboxes}
              hasPaymentMethod={billing.data.hasPaymentMethod}
              canCreate={canCreateMailboxes}
              onBack={back}
              onNext={forward}
              onSkip={forward}
              onGoToPayment={() => goTo('payment')}
            />
          )}
          {stepFromUrl === 'done' && back && (
            <DoneStep
              domainCount={domains.data.length}
              mailboxCount={liveMailboxes.length}
              canFinish={canUpdateSettings}
              onBack={back}
              onFinished={() => void navigate({ to: '/weldreach' })}
            />
          )}
        </CardContent>
      </Card>
    </DashboardPage>
  );
}
