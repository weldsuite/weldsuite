/**
 * "Confirm it's you" (ADR SEC-022): shown when the API refuses a sensitive
 * action until the person confirms their identity again. Continue opens the
 * provider's sign-in (`stepUp`, a popup on the web) in the click itself, and
 * once it is done every request that was waiting goes out once more, so a
 * form keeps what was typed. Requests refused while the dialog is open wait
 * for the same confirmation, at the strongest level any of them asked for.
 *
 * Mounted once, at the root, and only where the provider can do this (OIDC);
 * on Clerk the clients' refusals are thrown as before.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { MFA_REQUIRED, REVERIFICATION_REQUIRED, type StepUpChallenge } from '@weldsuite/api-client/step-up';
import { canStepUp, stepUp, StepUpError } from '@/lib/auth';
import { setStepUpHandler } from '@/lib/api/step-up';
import { getTranslations } from '@/lib/i18n';

interface Waiting {
  challenge: StepUpChallenge;
  resolvers: ((confirmed: boolean) => void)[];
}

/** The stronger of two challenges: a second factor beats a sign-in, setting one up beats both. */
export function strongerChallenge(a: StepUpChallenge, b: StepUpChallenge): StepUpChallenge {
  return {
    code: a.code === MFA_REQUIRED || b.code === MFA_REQUIRED ? MFA_REQUIRED : REVERIFICATION_REQUIRED,
    level: a.level === 'second_factor' || b.level === 'second_factor' ? 'second_factor' : 'first_factor',
    afterMinutes: a.afterMinutes ?? b.afterMinutes,
  };
}

export function StepUpDialogHost() {
  const t = getTranslations('common').auth.stepUp;
  const waiting = useRef<Waiting | null>(null);
  const [challenge, setChallenge] = useState<StepUpChallenge | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const finish = useCallback((confirmed: boolean) => {
    const done = waiting.current;
    waiting.current = null;
    setChallenge(null);
    setProblem(null);
    done?.resolvers.forEach((resolve) => resolve(confirmed));
  }, []);

  useEffect(() => {
    if (!canStepUp()) return;
    setStepUpHandler(
      (next) =>
        new Promise<boolean>((resolve) => {
          const current = waiting.current;
          waiting.current = current
            ? { challenge: strongerChallenge(current.challenge, next), resolvers: [...current.resolvers, resolve] }
            : { challenge: next, resolvers: [resolve] };
          setChallenge(waiting.current.challenge);
        }),
    );
    return () => {
      setStepUpHandler(null);
      // Nobody is left to ask: the waiting requests fail as refused.
      const left = waiting.current;
      waiting.current = null;
      left?.resolvers.forEach((resolve) => resolve(false));
    };
  }, []);

  if (!challenge) return null;
  const setUp = challenge.code === MFA_REQUIRED;
  let description = challenge.level === 'second_factor' ? t.secondFactorDescription : t.firstFactorDescription;
  if (setUp) description = t.mfaDescription;

  // Called straight from the click: `stepUp` opens its popup before any await.
  const confirm = () =>
    stepUp(challenge.level).then(
      () => finish(true),
      (err: unknown) => {
        if (err instanceof StepUpError && err.reason === 'other_account') {
          finish(false);
          return;
        }
        setProblem(err instanceof StepUpError && err.reason === 'cancelled' ? t.cancelled : t.failed);
      },
    );

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(false);
      }}
      title={setUp ? t.mfaTitle : t.title}
      description={
        <>
          {description}
          {problem ? (
            <span role="alert" className="mt-2 block text-destructive">
              {problem}
            </span>
          ) : null}
        </>
      }
      confirmLabel={setUp ? t.mfaConfirm : t.confirm}
      onConfirm={confirm}
    />
  );
}
