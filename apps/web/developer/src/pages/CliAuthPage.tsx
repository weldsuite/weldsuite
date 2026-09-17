import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  OrganizationSwitcher,
  SignIn,
  useAuth,
  useOrganization,
  useUser,
} from '@clerk/clerk-react';
import { CheckCircle2, Loader2, Terminal } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAppApiClient } from '@/lib/api';
import { useDeveloperI18n } from '@/lib/i18n';

const clerkAppearance = {
  variables: {
    colorPrimary: '#1e3a5f',
  },
} as const;

type Phase = 'sign-in' | 'pick-workspace' | 'ready' | 'approving' | 'done' | 'error';

/**
 * Browser half of `weld login` — user confirms the device code, selects a
 * workspace, and authorizes minting a personal `wsk_` key for the CLI.
 */
export function CliAuthPage() {
  const { t } = useDeveloperI18n();
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const { organization } = useOrganization();
  const { user } = useUser();
  const { getClient } = useAppApiClient();
  const [params] = useSearchParams();

  const initialCode = useMemo(() => (params.get('code') ?? '').trim(), [params]);
  const [userCode, setUserCode] = useState(initialCode);
  const [phase, setPhase] = useState<Phase>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ keyPrefix?: string; orgName?: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setPhase('sign-in');
      return;
    }
    if (!orgId) {
      setPhase('pick-workspace');
      return;
    }
    setPhase((current) => (current === 'done' || current === 'approving' ? current : 'ready'));
  }, [isLoaded, isSignedIn, orgId]);

  async function authorize() {
    const code = userCode.trim();
    if (!code) {
      setError(t.cliAuth.codeRequired);
      setPhase('error');
      return;
    }
    setError(null);
    setPhase('approving');
    try {
      const client = await getClient();
      const res = await client.post<{
        data: {
          status: string;
          keyPrefix?: string;
          orgName?: string | null;
          alreadyApproved?: boolean;
        };
      }>('/cli-auth/approve', { userCode: code });
      setResult({
        keyPrefix: res?.data?.keyPrefix,
        orgName: res?.data?.orgName ?? organization?.name ?? null,
      });
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t.cliAuth.approveError);
      setPhase('error');
    }
  }

  if (!isLoaded) {
    return (
      <Shell>
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t.shell.loading}</p>
      </Shell>
    );
  }

  if (phase === 'sign-in') {
    return (
      <Shell>
        <Header title={t.cliAuth.title} subtitle={t.cliAuth.signInHint} />
        <SignIn
          routing="hash"
          forceRedirectUrl={`/cli-auth${initialCode ? `?code=${encodeURIComponent(initialCode)}` : ''}`}
          appearance={clerkAppearance}
        />
      </Shell>
    );
  }

  if (phase === 'pick-workspace') {
    return (
      <Shell>
        <Header title={t.cliAuth.title} subtitle={t.cliAuth.selectWorkspaceHint} />
        <OrganizationSwitcher hidePersonal appearance={clerkAppearance} />
      </Shell>
    );
  }

  return (
    <Shell>
      <Header title={t.cliAuth.title} subtitle={t.cliAuth.subtitle} />

      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-background p-6 shadow-sm">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">{t.cliAuth.codeLabel}</span>
          <input
            value={userCode}
            onChange={(e) => setUserCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EF12"
            autoComplete="one-time-code"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-lg tracking-widest text-foreground outline-none focus:ring-2 focus:ring-primary/30"
            disabled={phase === 'approving' || phase === 'done'}
          />
        </label>

        <div className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <p>
            {t.cliAuth.workspaceLabel}:{' '}
            <span className="font-medium text-foreground">{organization?.name ?? orgId}</span>
          </p>
          {user?.primaryEmailAddress?.emailAddress ? (
            <p>
              {t.cliAuth.userLabel}:{' '}
              <span className="font-medium text-foreground">
                {user.primaryEmailAddress.emailAddress}
              </span>
            </p>
          ) : null}
          <div className="mt-2">
            <OrganizationSwitcher hidePersonal appearance={clerkAppearance} />
          </div>
        </div>

        {phase === 'error' && error ? <p className="text-sm text-red-600">{error}</p> : null}

        {phase === 'done' ? (
          <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-900">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">{t.cliAuth.doneTitle}</p>
              <p className="mt-1 text-green-800/90">{t.cliAuth.doneBody}</p>
              {result?.keyPrefix ? (
                <p className="mt-2 font-mono text-xs">{result.keyPrefix}…</p>
              ) : null}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void authorize()}
            disabled={phase === 'approving' || !userCode.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {phase === 'approving' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Terminal className="h-4 w-4" />
            )}
            {phase === 'approving' ? t.cliAuth.approving : t.cliAuth.authorize}
          </button>
        )}

        <p className="text-center text-xs text-muted-foreground">
          <Link to="/apps" className="underline-offset-2 hover:underline">
            {t.cliAuth.backToPortal}
          </Link>
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--shell-chrome)] px-4 py-10">
      {children}
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="max-w-md space-y-2 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}
