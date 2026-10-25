'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, MoreVertical, Send, XCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import type { SignPortalCompleteInput, SignPortalEnvelope } from '@weldsuite/app-api-client/schemas/weldsign';
import { EMPTY_SIGNING_STATE, missingRequired, sortedFields, type SigningState } from '@/lib/fields';
import type { Locale } from '@/lib/i18n';
import { PortalApiError, PortalNetworkError, portalJson } from '@/lib/portal-client';
import { initialsFromName } from '@/lib/signature';
import type { AdoptedSignature } from '@/lib/signing-types';
import { BrandButton } from './brand-button';
import { ConsentStep } from './consent-step';
import { DeclineDialog } from './decline-dialog';
import { DocumentView } from './document-view';
import { usePortal } from './portal-context';
import { PortalFrame } from './portal-frame';
import { SignatureDialog } from './signature-dialog';

interface SignViewProps {
  envelope: SignPortalEnvelope;
  /** Version of the disclosure text this portal shows; stored with the consent. */
  disclosureVersion: string;
  withSession: <T>(run: () => Promise<T>) => Promise<T>;
  onEnvelope: (envelope: SignPortalEnvelope) => void;
  onLocaleChange: (locale: Locale) => void;
}

/** A text or checkbox field's value as the server expects it. */
function submittedValue(type: SignPortalEnvelope['fields'][number]['type'], raw: string | undefined): string {
  if (type === 'checkbox') return raw === 'true' ? 'true' : 'false';
  return (raw ?? '').trim();
}

/** The signer's turn: consent, then the document with its fields, then Finish. */
export function SignView({ envelope, disclosureVersion, withSession, onEnvelope, onLocaleChange }: Readonly<SignViewProps>) {
  const { t, locale } = usePortal();
  const [consented, setConsented] = useState(envelope.recipient.consented);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const [state, setState] = useState<SigningState>(EMPTY_SIGNING_STATE);
  const [adopting, setAdopting] = useState<'signature' | 'initials' | null>(null);
  const [declining, setDeclining] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const elements = useRef(new Map<string, HTMLElement>());
  const lastGuided = useRef(-1);
  const highlightTimer = useRef<number | null>(null);

  const ordered = useMemo(() => sortedFields(envelope), [envelope]);
  const missing = useMemo(() => missingRequired(ordered, state), [ordered, state]);
  const hasSignatureField = envelope.fields.some((f) => f.type === 'signature');
  const hasInitialsField = envelope.fields.some((f) => f.type === 'initials');

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    },
    [],
  );

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  const onValue = useCallback((id: string, value: string) => {
    setState((prev) => ({ ...prev, values: { ...prev.values, [id]: value } }));
  }, []);

  const autoText = useCallback(
    (type: 'name' | 'email' | 'date_signed') => {
      if (type === 'name') return envelope.recipient.name ?? '';
      if (type === 'email') return envelope.recipient.email ?? '';
      // The server stamps the real date; this is what the signer will see.
      return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    },
    [envelope.recipient.name, envelope.recipient.email, locale],
  );

  async function agree() {
    setConsentBusy(true);
    setConsentError(null);
    try {
      await withSession(() => portalJson<{ consented: boolean }>('/api/portal/consent', { disclosureVersion }));
      setConsented(true);
    } catch (err) {
      setConsentError(err instanceof PortalNetworkError ? t.error.network : t.error.generic);
    } finally {
      setConsentBusy(false);
    }
  }

  function goToNext() {
    if (missing.length === 0) return;
    const indexOf = (id: string) => ordered.findIndex((f) => f.id === id);
    const target = missing.find((f) => indexOf(f.id) > lastGuided.current) ?? missing[0];
    if (!target) return;
    lastGuided.current = indexOf(target.id);
    const el = elements.current.get(target.id);
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    if (el instanceof HTMLInputElement) el.focus({ preventScroll: true });
    setHighlightedId(target.id);
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightedId(null), 1800);
  }

  function adopt(value: AdoptedSignature) {
    setState((prev) => (adopting === 'initials' ? { ...prev, initials: value } : { ...prev, signature: value }));
    setAdopting(null);
  }

  async function finish() {
    if (missing.length > 0 || finishing) return;
    setFinishing(true);
    setFinishError(null);
    const values = envelope.fields
      .filter((f) => f.type === 'text' || f.type === 'checkbox')
      .map((f) => ({ fieldId: f.id, value: submittedValue(f.type, state.values[f.id]) }));
    const body: SignPortalCompleteInput = {
      values,
      signature: hasSignatureField ? state.signature : null,
      initials: hasInitialsField ? state.initials : null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    };
    try {
      const next = await withSession(() => portalJson<SignPortalEnvelope>('/api/portal/complete', body));
      onEnvelope(next);
    } catch (err) {
      if (err instanceof PortalNetworkError) setFinishError(t.error.network);
      else if (err instanceof PortalApiError && err.status === 401) setFinishError(t.sign.sessionExpired);
      // Signed, but the request could not be finished yet: finishing again picks it up.
      else if (err instanceof PortalApiError && err.status === 503) setFinishError(t.sign.finishPending);
      else setFinishError(t.sign.finishFailed);
      setFinishing(false);
    }
  }

  async function decline(reason: string) {
    const next = await withSession(() => portalJson<SignPortalEnvelope>('/api/portal/decline', { reason }));
    onEnvelope(next);
  }

  const optionsMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t.sign.menu} className="shrink-0">
          <MoreVertical aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={() => setDeclining(true)}>
          <XCircle aria-hidden="true" />
          {t.sign.decline}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const declineDialog = <DeclineDialog open={declining} onSubmit={decline} onClose={() => setDeclining(false)} />;

  if (!consented) {
    return (
      <PortalFrame brand={envelope.brand} onLocaleChange={onLocaleChange}>
        <ConsentStep
          title={envelope.title}
          senderName={envelope.senderName}
          message={envelope.message}
          busy={consentBusy}
          error={consentError}
          onAgree={agree}
          onDecline={() => setDeclining(true)}
        />
        {declineDialog}
      </PortalFrame>
    );
  }

  return (
    <PortalFrame brand={envelope.brand} onLocaleChange={onLocaleChange} actions={optionsMenu} hasBottomBar>
      <main className="flex flex-1 flex-col">
        <div className="mx-auto w-full max-w-3xl px-3 pt-4 sm:px-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <h1 className="text-base font-semibold sm:text-lg">{envelope.title}</h1>
            {envelope.senderName ? <p className="text-sm text-muted-foreground">{t.sign.from(envelope.senderName)}</p> : null}
            {envelope.message ? <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{envelope.message}</p> : null}
          </div>
        </div>

        <DocumentView
          envelope={envelope}
          state={state}
          withSession={withSession}
          autoText={autoText}
          highlightedId={highlightedId}
          register={register}
          onValue={onValue}
          onAdopt={setAdopting}
        />
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 py-3 sm:px-4">
          {finishError ? (
            <p role="alert" className="text-sm text-destructive">
              {finishError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <p className="w-full text-sm text-muted-foreground sm:w-auto sm:min-w-0 sm:flex-1" aria-live="polite">
              {missing.length > 0 ? t.sign.fieldsLeft(missing.length) : t.sign.allDone}
            </p>
            {missing.length > 0 ? (
              <Button variant="outline" className="flex-1 sm:flex-none" onClick={goToNext}>
                <ArrowDown aria-hidden="true" />
                {t.sign.next}
              </Button>
            ) : null}
            <BrandButton className="flex-1 sm:flex-none" onClick={finish} disabled={missing.length > 0 || finishing}>
              {finishing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              {finishing ? t.sign.finishing : t.sign.finish}
            </BrandButton>
          </div>
        </div>
      </div>

      <SignatureDialog
        open={adopting !== null}
        variant={adopting ?? 'signature'}
        suggestedText={adopting === 'initials' ? initialsFromName(envelope.recipient.name) : (envelope.recipient.name ?? '')}
        onAdopt={adopt}
        onClose={() => setAdopting(null)}
      />
      {declineDialog}
    </PortalFrame>
  );
}
