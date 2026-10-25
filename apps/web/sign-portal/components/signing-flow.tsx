import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Link2Off, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { SignPortalClosedReason, SignPortalEnvelope, SignPortalSessionResponse } from '@weldsuite/app-api-client/schemas/weldsign';
import { readableOn, safeBrandColor } from '@/lib/brand';
import { dictionaries, type Locale } from '@/lib/i18n';
import { PortalApiError, PortalNetworkError, portalJson, setSigningLink } from '@/lib/portal-client';
import { CodeForm } from './code-form';
import { PortalProvider } from './portal-context';
import { PortalFrame } from './portal-frame';
import { ClosedView, CompletedView, WaitingView } from './result-view';
import { SignView } from './sign-view';
import { StatusCard } from './status-card';

type Phase =
  | { kind: 'opening' }
  | { kind: 'notFound' }
  | { kind: 'error'; network: boolean }
  | { kind: 'code'; method: 'email_code' | 'access_code'; emailHint: string | null }
  | { kind: 'closed'; reason: SignPortalClosedReason }
  | { kind: 'envelope'; envelope: SignPortalEnvelope };

interface SigningFlowProps {
  /** The token from `/r/<token>`. */
  token: string;
  /** Locale from the browser's Accept-Language, until the recipient's own is known. */
  initialLocale: Locale;
  /** Version of the e-signature disclosure this portal shows. */
  disclosureVersion: string;
}

/** Thrown when the session could not be renewed silently (a code is needed again, or the request closed). */
class SessionEndedError extends Error {}

/**
 * The whole signer journey for one link: open it, ask for a code if needed,
 * load the envelope, then sign, wait, download or show why it is closed.
 */
export function SigningFlow({ token, initialLocale, disclosureVersion }: Readonly<SigningFlowProps>) {
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const pickedLocale = useRef(false);
  const renewing = useRef<Promise<SignPortalSessionResponse> | null>(null);

  const loadEnvelope = useCallback(async () => {
    try {
      const envelope = await portalJson<SignPortalEnvelope>('/api/portal/envelope');
      if (!pickedLocale.current) setLocale(envelope.recipient.locale);
      setPhase({ kind: 'envelope', envelope });
    } catch (err) {
      setPhase({ kind: 'error', network: err instanceof PortalNetworkError });
    }
  }, []);

  const applyAnswer = useCallback(
    (answer: SignPortalSessionResponse) => {
      if (answer.state === 'ready') {
        void loadEnvelope();
      } else if (answer.state === 'code_required') {
        setPhase({ kind: 'code', method: answer.method, emailHint: answer.emailHint });
      } else {
        setPhase({ kind: 'closed', reason: answer.reason });
      }
    },
    [loadEnvelope],
  );

  const openLink = useCallback(async () => {
    // Every portal call names this link, so the server uses its own session cookie.
    setSigningLink(token);
    setPhase({ kind: 'opening' });
    try {
      applyAnswer(await portalJson<SignPortalSessionResponse>('/api/session', { token }));
    } catch (err) {
      if (err instanceof PortalApiError && (err.status === 404 || err.status === 400)) setPhase({ kind: 'notFound' });
      else setPhase({ kind: 'error', network: err instanceof PortalNetworkError });
    }
  }, [token, applyAnswer]);

  useEffect(() => {
    void openLink();
  }, [openLink]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  /** Runs a request; on 401 renews the session from the link token and retries once. */
  const withSession = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        if (!(err instanceof PortalApiError) || err.status !== 401) throw err;
        // Several requests can expire together; renew once.
        renewing.current ??= portalJson<SignPortalSessionResponse>('/api/session', { token }).finally(() => {
          renewing.current = null;
        });
        const answer = await renewing.current;
        if (answer.state !== 'ready') {
          applyAnswer(answer);
          throw new SessionEndedError();
        }
        return run();
      }
    },
    [token, applyAnswer],
  );

  const changeLocale = useCallback((next: Locale) => {
    pickedLocale.current = true;
    setLocale(next);
  }, []);

  const envelope = phase.kind === 'envelope' ? phase.envelope : null;
  const brandColor = safeBrandColor(envelope?.brand.color);
  const context = useMemo(
    () => ({ locale, t: dictionaries[locale], brandColor, brandForeground: brandColor ? readableOn(brandColor) : null }),
    [locale, brandColor],
  );
  const t = context.t;
  const brand = envelope?.brand ?? null;

  function frame(children: React.ReactNode) {
    return (
      <PortalFrame brand={brand} onLocaleChange={changeLocale}>
        {children}
      </PortalFrame>
    );
  }

  let content: React.ReactNode;
  switch (phase.kind) {
    case 'opening':
      content = frame(
        <StatusCard icon={Loader2} spin title={t.opening.title}>
          <span className="sr-only" role="status">
            {t.loading}
          </span>
        </StatusCard>,
      );
      break;
    case 'notFound':
      content = frame(<StatusCard icon={Link2Off} tone="neutral" title={t.notFound.title} body={t.notFound.body} />);
      break;
    case 'error':
      content = frame(
        <StatusCard icon={AlertTriangle} tone="warning" title={t.error.title} body={phase.network ? t.error.network : t.error.body}>
          <Button variant="outline" onClick={() => void openLink()}>
            {t.error.retry}
          </Button>
        </StatusCard>,
      );
      break;
    case 'code':
      content = frame(
        <CodeForm
          token={token}
          method={phase.method}
          emailHint={phase.emailHint}
          onAnswer={applyAnswer}
        />,
      );
      break;
    case 'closed':
      content = frame(<ClosedView reason={phase.reason} />);
      break;
    case 'envelope': {
      const env = phase.envelope;
      const update = (next: SignPortalEnvelope) => setPhase({ kind: 'envelope', envelope: next });
      if (env.mode === 'sign') {
        content = (
          <SignView
            key={env.recipient.id}
            envelope={env}
            disclosureVersion={disclosureVersion}
            withSession={withSession}
            onEnvelope={update}
            onLocaleChange={changeLocale}
          />
        );
      } else if (env.mode === 'completed') {
        content = frame(<CompletedView envelope={env} withSession={withSession} />);
      } else if (env.mode === 'waiting') {
        content = frame(<WaitingView envelope={env} />);
      } else {
        content = frame(<ClosedView reason={env.closedReason} declinedByYou={env.recipient.status === 'declined'} />);
      }
      break;
    }
  }

  return <PortalProvider value={context}>{content}</PortalProvider>;
}
