
import * as React from 'react';
import { useAuth, useOrganizationList } from '@clerk/clerk-react';
import { Button } from '@weldsuite/ui/components/button';
import { motion } from 'framer-motion';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useDatabaseStatus, useFinalizeOnboarding, useRetryProvisioning } from '@/hooks/use-onboarding';
import { getTranslations } from '@/lib/i18n';

const MAX_POLL_ATTEMPTS = 90; // 3 minutes max

interface ProvisioningStep {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface ProvisioningScreenProps {
  /** Skip the initial retryProvisioning() call -- set true when rendered from the wizard (provisioning was just triggered) */
  skipRetry?: boolean;
}

export function ProvisioningScreen({ skipRetry = false }: ProvisioningScreenProps) {
  const t = getTranslations('common');
  const { orgId } = useAuth();
  const { setActive } = useOrganizationList();
  const [pollCount, setPollCount] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
  const [steps, setSteps] = React.useState<ProvisioningStep[]>([
    {
      id: 'database',
      label: t.onboarding.provisioning.stepDatabase,
      status: 'in_progress',
    },
    {
      id: 'security',
      label: t.onboarding.provisioning.stepSecurity,
      status: 'pending',
    },
    {
      id: 'features',
      label: t.onboarding.provisioning.stepFeatures,
      status: 'pending',
    },
  ]);

  const retryMutation = useRetryProvisioning();
  const finalizeMutation = useFinalizeOnboarding();

  // Poll database status with refetchInterval built into the hook
  const { data: dbStatus } = useDatabaseStatus(!!orgId);

  // Trigger provisioning on mount as fallback (only when rendered from page.tsx, not from wizard).
  const retryAttempted = React.useRef(false);
  React.useEffect(() => {
    if (skipRetry || retryAttempted.current) return;
    retryAttempted.current = true;
    retryMutation.mutateAsync().catch((err) => {
      console.warn('[Provisioning] Retry provisioning failed:', err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipRetry]);

  // Track poll count for visual progress
  React.useEffect(() => {
    if (pollCount >= MAX_POLL_ATTEMPTS) return;
    const timer = setTimeout(() => {
      setPollCount((prev) => prev + 1);
    }, 2000);
    return () => clearTimeout(timer);
  }, [pollCount]);

  // Simulate progress through steps while actually waiting
  React.useEffect(() => {
    const progressTimer = setTimeout(() => {
      if (pollCount > 5) {
        setSteps((prev) =>
          prev.map((step) =>
            step.id === 'database' ? { ...step, status: 'completed' } : step
          )
        );
        setSteps((prev) =>
          prev.map((step) =>
            step.id === 'security' ? { ...step, status: 'in_progress' } : step
          )
        );
      }
      if (pollCount > 10) {
        setSteps((prev) =>
          prev.map((step) =>
            step.id === 'security' ? { ...step, status: 'completed' } : step
          )
        );
        setSteps((prev) =>
          prev.map((step) =>
            step.id === 'features' ? { ...step, status: 'in_progress' } : step
          )
        );
      }
    }, 100);

    return () => clearTimeout(progressTimer);
  }, [pollCount]);

  // Handle finalization when DB is ready
  const finalizationTriggered = React.useRef(false);
  React.useEffect(() => {
    if (!dbStatus?.provisioned || !dbStatus?.migrated || finalizationTriggered.current) return;
    finalizationTriggered.current = true;

    (async () => {
      // Finalize onboarding (mark complete, install apps)
      try {
        await finalizeMutation.mutateAsync();
      } catch (err) {
        console.error('[Provisioning] Error finalizing onboarding:', err);
      }

      // Mark all steps as completed
      setSteps((prev) =>
        prev.map((step) => ({ ...step, status: 'completed' as const }))
      );

      // Enforce org-scoped session before redirect
      if (orgId && setActive) {
        try {
          await setActive({ organization: orgId });
        } catch (err) {
          console.error('[Provisioning] Error setting active org:', err);
        }
      }

      // Hard redirect to ensure fresh cookies are sent to the server
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbStatus?.provisioned, dbStatus?.migrated, orgId]);

  // Terminal failure reported by the backend — let the user retry instead of
  // spinning forever or being dropped into a half-built workspace.
  const isFailed = !!dbStatus?.failed && !dbStatus?.provisioned;

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    finalizationTriggered.current = false;
    try {
      await retryMutation.mutateAsync();
    } catch (err) {
      console.warn('[Provisioning] Retry provisioning failed:', err);
    } finally {
      setRetrying(false);
      setPollCount(0); // restart the progress/timeout window
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center">
      <div className="w-full max-w-sm px-8">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-left"
        >
          <h1 className="text-xl font-semibold text-gray-900">
            {t.onboarding.provisioning.title}
          </h1>
          <p className="text-sm text-gray-500 mt-1.5">
            {t.onboarding.provisioning.subtitle}
          </p>
        </motion.div>

        <div className="mt-10 space-y-0">
          {steps.map((step, index) => (
            <motion.div
              key={step.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: index * 0.08 }}
              className="flex items-center gap-3 py-3"
            >
              <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                {step.status === 'completed' ? (
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                  >
                    <CheckCircle2 className="h-[18px] w-[18px] text-gray-900" />
                  </motion.div>
                ) : step.status === 'in_progress' ? (
                  <Loader2 className="h-[18px] w-[18px] animate-spin text-gray-400" />
                ) : (
                  <div className="h-[18px] w-[18px] rounded-full border-[1.5px] border-gray-200" />
                )}
              </div>
              <span
                className={`text-sm ${
                  step.status === 'completed'
                    ? 'text-gray-900'
                    : step.status === 'in_progress'
                    ? 'text-gray-700'
                    : 'text-gray-400'
                }`}
              >
                {step.label}
              </span>
            </motion.div>
          ))}
        </div>


        {isFailed ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-8"
          >
            <h2 className="text-sm font-semibold text-gray-900">
              {t.onboarding.provisioning.failedTitle}
            </h2>
            <p className="text-sm text-gray-500 mt-1.5">
              {t.onboarding.provisioning.failedMessage}
            </p>
            <Button
              onClick={handleRetry}
              disabled={retrying}
              className="mt-4"
            >
              {retrying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t.onboarding.provisioning.tryAgain
              )}
            </Button>
          </motion.div>
        ) : pollCount >= MAX_POLL_ATTEMPTS ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-8 text-center"
          >
            <p className="text-sm text-gray-500">
              {t.onboarding.provisioning.takingLonger}{' '}
              <Button
                variant="link"
                onClick={() => window.location.reload()}
                className="text-gray-900 font-medium hover:underline"
              >
                {t.onboarding.provisioning.refresh}
              </Button>
            </p>
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}
