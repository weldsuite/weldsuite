import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import {
  decideLinkAction,
  linkReasonKey,
  parseInterstitialFragment,
  type LinkDecision,
} from '../lib/link-protection';

/** Leaves this page for `url`, without handing the destination this window or this address. */
function openDestination(url: string) {
  window.opener = null;
  window.location.replace(url);
}

/** Closes the tab this page opened in, or steps back (or home) when it can't. */
function goBack() {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.close();
  // `window.close()` does nothing in a tab the reader opened by hand.
  setTimeout(() => {
    if (!window.closed) window.location.assign('/weldmail');
  }, 150);
}

/** No `Referer` on the way out: the destination must not learn where the link was read. */
function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

/**
 * The page every link in a received message opens (see `lib/link-protection.ts`).
 * It asks the server to check the destination, then forwards the reader when it
 * is safe, warns when it is suspicious, blocks it when it is known-dangerous,
 * and fails open, visibly, when the check itself fails.
 */
export default function LinkInterstitialPage() {
  const { t } = useI18n();
  const copy = t.mail.linkProtection;
  const { mailMessages } = useAppApi();
  useNoReferrer();

  // The fragment is read once: it is not part of the router's location.
  const target = useMemo(() => parseInterstitialFragment(window.location.hash), []);
  const enabled = isFeatureAvailable('mail-threat-protection');

  const check = useQuery({
    queryKey: ['mail-link-check', target.ok ? target.messageId : null, target.ok ? target.url : null],
    queryFn: async () => {
      if (!target.ok) return null;
      const response = await mailMessages.linkCheck(target.messageId, {
        url: target.url,
        ...(target.text ? { text: target.text } : {}),
      });
      return response.data;
    },
    enabled: target.ok && enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const decision: LinkDecision | null = useMemo(() => {
    if (check.isPending) return null;
    return decideLinkAction(check.isError ? null : (check.data ?? null));
  }, [check.isPending, check.isError, check.data]);

  const safeUrl = target.ok && decision?.action === 'forward' ? target.url : null;
  useEffect(() => {
    if (safeUrl) openDestination(safeUrl);
  }, [safeUrl]);

  useEffect(() => {
    document.title = copy.pageTitle;
  }, [copy.pageTitle]);

  if (!enabled) return <EditionUnavailablePage />;

  if (!target.ok) {
    return (
      <Shell>
        <InfoBanner variant="danger" title={copy.invalidTitle}>
          {copy.invalidDescription}
        </InfoBanner>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={goBack}>
            {copy.goBack}
          </Button>
        </div>
      </Shell>
    );
  }

  if (decision === null || decision.action === 'forward') {
    return <PageLoader label={copy.checking} appearDelayMs={0} />;
  }

  return <LinkDecisionCard decision={decision} host={target.host} url={target.url} copy={copy} />;
}

type LinkCopy = ReturnType<typeof useI18n>['t']['mail']['linkProtection'];
type ShownDecision = Exclude<LinkDecision, { action: 'forward' }>;

/** The heading and banner text of each verdict the reader gets to see. */
function decisionText(action: ShownDecision['action'], copy: LinkCopy): { title: string; description: string } {
  switch (action) {
    case 'block':
      return { title: copy.maliciousTitle, description: copy.maliciousDescription };
    case 'warn':
      return { title: copy.suspiciousTitle, description: copy.suspiciousDescription };
    case 'unverified':
      return { title: copy.unverifiedTitle, description: copy.unverifiedDescription };
  }
}

/** The actions under a verdict: blocked links only go back (plus a small way through below). */
function DecisionActions({ action, url, copy }: Readonly<{ action: ShownDecision['action']; url: string; copy: LinkCopy }>) {
  if (action === 'block') return <Button onClick={goBack}>{copy.goBack}</Button>;
  const unverified = action === 'unverified';
  return (
    <>
      <Button variant={unverified ? 'outline' : 'default'} onClick={goBack}>
        {copy.goBack}
      </Button>
      <Button variant={unverified ? 'default' : 'outline'} onClick={() => openDestination(url)}>
        {unverified ? copy.openLink : copy.openAnyway}
      </Button>
    </>
  );
}

/** A suspicious, dangerous or unchecked link: what was found, where it goes, and the reader's choice. */
function LinkDecisionCard({
  decision,
  host,
  url,
  copy,
}: Readonly<{ decision: ShownDecision; host: string; url: string; copy: LinkCopy }>) {
  const blocked = decision.action === 'block';
  const text = decisionText(decision.action, copy);
  const reasonKeys = 'reasons' in decision ? decision.reasons.map((reason) => linkReasonKey(reason)).filter(Boolean) : [];

  return (
    <Shell>
      <div className="mb-4 flex items-center gap-3">
        {blocked ? (
          <ShieldAlert className="h-8 w-8 shrink-0 text-destructive" aria-hidden />
        ) : (
          <ShieldQuestion className="h-8 w-8 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        )}
        <h1 className="text-lg font-semibold text-foreground">{text.title}</h1>
      </div>

      <InfoBanner variant={blocked ? 'danger' : 'warning'}>{text.description}</InfoBanner>

      {reasonKeys.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground">
          {reasonKeys.map((key) => (
            <li key={key}>{copy[key]}</li>
          ))}
        </ul>
      )}

      <dl className="mt-5 space-y-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.destination}</dt>
          <dd className="mt-1 break-all text-xl font-semibold text-foreground">{host}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{copy.fullAddress}</dt>
          <dd className="mt-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {url}
          </dd>
        </div>
      </dl>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <DecisionActions action={decision.action} url={url} copy={copy} />
      </div>

      {blocked && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => openDestination(url)}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {copy.openAtOwnRisk}
          </button>
        </div>
      )}
    </Shell>
  );
}

/** The bare full-page layout: no sidebar, one centred card. */
function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-sm">{children}</div>
    </main>
  );
}
