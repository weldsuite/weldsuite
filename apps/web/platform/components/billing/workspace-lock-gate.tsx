
/**
 * WorkspaceLockGate — post-trial paywall.
 *
 * When a workspace's 14-day trial (or subscription) ends without a payment
 * method on file, `GET /api/billing/subscription` answers `isLocked: true`.
 * This component blocks the ENTIRE app behind a full-screen, non-dismissible
 * overlay in that case — see `apps/web/platform/components/app-shell-client.tsx`
 * for where it's wired in (wraps `<PlatformShell>`, so the sidebar + content
 * render nothing while locked; only `/auth`, `/onboarding`, `/invite` and the
 * other "minimal routes" bypass it entirely).
 *
 * Owners/admins get a primary CTA that starts the exact same Stripe Checkout
 * flow as the Plans settings page (`billing-settings-section.tsx`):
 * `POST /billing/checkout` with the Business plan's id, then redirect to the
 * returned `url`. Regular members see a message to ask an owner/admin.
 */

import { useMemo } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { format, differenceInCalendarDays } from 'date-fns';
import { toast } from 'sonner';
import { useOrganization } from '@clerk/clerk-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import {
  useSubscription,
  useBillingPlans,
  useChangePlan,
} from '@/hooks/queries/use-billing-queries';

/** Plan the lockout checkout offers — mirrors the Business-plan checkout CTA on the Plans page. */
const LOCKOUT_TARGET_PLAN_SLUG = 'business';

interface WorkspaceLockGateProps {
  children: React.ReactNode;
}

export function WorkspaceLockGate({ children }: WorkspaceLockGateProps) {
  const { t } = useI18n();
  const ts = t.settings.billing.lockout;
  const { organization } = useOrganization();
  const { isOwner, role } = usePermissions();
  const { data: subscription, isLoading: isSubscriptionLoading } = useSubscription();

  const isLocked = subscription?.isLocked === true;
  // Owners always qualify; ADMIN is the other workspace role that can manage
  // billing (MEMBER / VIEWER cannot). `role` comes from the same resolver the
  // rest of the platform uses for permission checks.
  const canManageBilling = isOwner || role === 'ADMIN';

  const { data: plansData, isLoading: isPlansLoading } = useBillingPlans(isLocked && canManageBilling);
  const changePlanMutation = useChangePlan();

  const targetPlan = useMemo(
    () => plansData?.plans.find((plan) => plan.slug === LOCKOUT_TARGET_PLAN_SLUG) ?? null,
    [plansData],
  );

  // While the subscription query is in flight, render children — never flash
  // the paywall before we actually know the lock state.
  if (isSubscriptionLoading) {
    return <>{children}</>;
  }

  if (!isLocked) {
    return <>{children}</>;
  }

  const workspaceName = organization?.name || subscription?.planName || '';
  const scheduledDeletionAt = subscription?.scheduledDeletionAt;
  const deletionDate = scheduledDeletionAt ? new Date(scheduledDeletionAt) : null;
  const daysUntilDeletion = deletionDate ? differenceInCalendarDays(deletionDate, new Date()) : null;

  const deletionCopy =
    deletionDate && daysUntilDeletion !== null && daysUntilDeletion >= 0
      ? ts.deletionWarningWithDays
          .replace('{date}', format(deletionDate, 'MMM dd, yyyy'))
          .replace('{days}', String(daysUntilDeletion))
      : deletionDate
        ? ts.deletionWarning.replace('{date}', format(deletionDate, 'MMM dd, yyyy'))
        : null;

  const isCheckingOut = changePlanMutation.isPending;

  const handleAddPaymentMethod = async () => {
    if (!targetPlan) {
      toast.error(ts.noPlanAvailable);
      return;
    }
    try {
      const seats = Math.max(subscription?.usedSeats ?? 1, 1);
      const result = await changePlanMutation.mutateAsync({
        planId: targetPlan.id,
        seats,
        cycle: 'monthly',
      });
      if (result?.url) {
        window.location.href = result.url;
        return;
      }
      toast.error(ts.checkoutFailed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : ts.checkoutFailed);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle className="text-xl">{ts.title}</CardTitle>
          <CardDescription>{ts.description.replace('{workspace}', workspaceName)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {deletionCopy && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-center text-sm text-destructive">
              {deletionCopy}
            </div>
          )}

          {canManageBilling ? (
            <Button
              className="w-full"
              onClick={handleAddPaymentMethod}
              disabled={isCheckingOut || isPlansLoading || !targetPlan}
            >
              {isCheckingOut ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {ts.addingPaymentMethod}
                </>
              ) : (
                ts.addPaymentMethod
              )}
            </Button>
          ) : (
            <p className="text-center text-sm text-muted-foreground">{ts.askOwner}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
