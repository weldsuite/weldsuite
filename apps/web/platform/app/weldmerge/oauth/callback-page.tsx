import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import type {
  MergeAzureOrganizationOption,
  MergeOauthCallbackResult,
} from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { AzureOrganizationPicker } from '../components/azure-organization-picker';
import { useMergeOauthCallback } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { fill } from '../lib/format';

const SETTINGS_PATH = '/weldmerge/settings';
const REDIRECT_DELAY_MS = 1200;

/** Where to go afterwards: the state's `returnTo` when it is a same-app path, else the settings tab for what was linked. */
export function resolveReturnTo(result: Pick<MergeOauthCallbackResult, 'returnTo' | 'purpose'>): string {
  const target = result.returnTo;
  if (target?.startsWith('/') && !target.startsWith('//')) return target;
  return `${SETTINGS_PATH}?tab=${result.purpose === 'account' ? 'accounts' : 'providers'}`;
}

type Phase =
  | { kind: 'working' }
  | { kind: 'done'; result: MergeOauthCallbackResult }
  | { kind: 'organization'; connectionId: string; organizations: MergeAzureOrganizationOption[]; returnTo: string }
  | { kind: 'error'; message: string };

/**
 * The page every provider's OAuth app redirects to. It hands `code` and `state`
 * to merge-api once, then returns to where the member started (or to settings).
 * Azure DevOps with several organisations stops here to ask which to use.
 */
export default function WeldMergeOauthCallbackPage({
  code,
  state,
  error,
  errorDescription,
}: Readonly<{ code?: string; state?: string; error?: string; errorDescription?: string }>) {
  const { t } = useI18n();
  const to = t.weldmerge.sync.oauth;
  const router = useRouter();
  const callback = useMergeOauthCallback();
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });

  useEffect(() => {
    // A code is single use: never send it twice (strict mode runs effects twice).
    if (started.current) return;
    started.current = true;

    if (error) {
      setPhase({ kind: 'error', message: fill(to.errorDenied, { reason: errorDescription || error }) });
      return;
    }
    if (!code || !state) {
      setPhase({ kind: 'error', message: to.errorMissing });
      return;
    }
    callback.mutate(
      { code, state },
      {
        onSuccess: (result) => {
          if (result.organizations && result.organizations.length > 1 && result.connectionId) {
            setPhase({
              kind: 'organization',
              connectionId: result.connectionId,
              organizations: result.organizations,
              returnTo: resolveReturnTo(result),
            });
            return;
          }
          setPhase({ kind: 'done', result });
        },
        onError: () => setPhase({ kind: 'error', message: to.errorFailed }),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival
  }, []);

  const finished = phase.kind === 'done' ? phase.result : null;
  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(() => router.replace(resolveReturnTo(finished)), REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [finished, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      {phase.kind === 'working' && (
        <div className="space-y-2 text-center">
          <InlineSpinner />
          <h1 className="text-lg font-semibold">{to.connecting}</h1>
          <p className="text-sm text-muted-foreground">{to.connectingHint}</p>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="space-y-2 text-center">
          <CheckCircle2 className="mx-auto size-12 text-green-500" aria-hidden="true" />
          <h1 className="text-lg font-semibold">
            {fill(phase.result.purpose === 'account' ? to.successAccount : to.successConnection, {
              provider: t.weldmerge.provider[phase.result.provider],
            })}
          </h1>
          <p className="text-sm text-muted-foreground">{to.successHint}</p>
        </div>
      )}

      {phase.kind === 'organization' && (
        <AzureOrganizationPicker
          connectionId={phase.connectionId}
          organizations={phase.organizations}
          onDone={() => router.replace(phase.returnTo)}
        />
      )}

      {phase.kind === 'error' && (
        <div className="max-w-md space-y-4 text-center">
          <ErrorState
            message={
              <>
                <span className="block font-medium">{to.errorTitle}</span>
                {phase.message}
              </>
            }
          />
          <Button onClick={() => router.replace(`${SETTINGS_PATH}?tab=providers`)}>{to.backToSettings}</Button>
        </div>
      )}
    </div>
  );
}
