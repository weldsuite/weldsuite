import { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { Languages } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { callTranslationTtsLocale } from '@weldsuite/core-api-client/schemas/desk-call-translation';
import { getLocale, getTranslations } from '@/lib/i18n';
import { useDeskTranslationAvailable } from '@/app/welddesk/inbox/translation/translation-state';
import {
  deskCallTranslationFailure,
  useDeskCallTranslation,
  useStartDeskCallTranslation,
  useStopDeskCallTranslation,
  useUpdateDeskCallTranslation,
  type DeskCallTranslationFailure,
} from '@/hooks/queries/use-desk-call-translation-queries';
import { CallCaptionsPanel, CallTranslationStoppedBanner } from './call-captions-panel';
import { CallTranslationDialog, DETECT, toRequest, type CallTranslationChoice } from './call-translation-dialog';
import { cleared, deskCallTranslationAtom } from './call-translation-state';

const OFFERED_UI_LANGUAGES = ['en', 'nl'];

/** The agent's UI language as the default for "your language". */
function defaultAgentLanguage(): string {
  const ui = getLocale().split('-')[0]!.toLowerCase();
  return OFFERED_UI_LANGUAGES.includes(ui) ? ui : 'en';
}

/**
 * Translate control and live captions on an answered inbound WeldDesk call.
 * Shown only where the AI exists (feature `desk-ai`) and the member may work
 * conversations; call-api checks that the call is theirs and live.
 */
export function DeskCallTranslation({ callId }: Readonly<{ callId: string }>) {
  const available = useDeskTranslationAvailable();
  if (!available) return null;
  return <TranslationForCall callId={callId} />;
}

function TranslationForCall({ callId }: Readonly<{ callId: string }>) {
  const t = getTranslations('deskCallTranslation');
  const [live, setLive] = useAtom(deskCallTranslationAtom);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [failure, setFailure] = useState<DeskCallTranslationFailure | null>(null);
  const { data: state } = useDeskCallTranslation(callId);
  const start = useStartDeskCallTranslation(callId);
  const update = useUpdateDeskCallTranslation(callId);
  const stop = useStopDeskCallTranslation(callId);

  // The call is over (this panel goes away with it): forget its lines.
  useEffect(() => () => setLive((prev) => cleared(prev, callId)), [callId, setLive]);

  const mine = live?.callId === callId ? live : null;
  const stoppedBySystem = mine?.stopped === true;
  const active = state?.active === true && !stoppedBySystem;
  const callerLanguage = mine?.callerLanguage ?? state?.callerLanguage ?? null;
  const speakAvailable = mine?.speakAvailable ?? (callerLanguage ? callTranslationTtsLocale(callerLanguage) !== null : false);

  const initial: CallTranslationChoice = {
    callerLanguage: active ? (callerLanguage ?? DETECT) : DETECT,
    agentLanguage: state?.agentLanguage ?? defaultAgentLanguage(),
    speakToCaller: state?.speakToCaller ?? true,
  };

  const submit = (choice: CallTranslationChoice) => {
    setFailure(null);
    const done = () => setDialogOpen(false);
    const fail = (err: unknown) => {
      setDialogOpen(false);
      setFailure(deskCallTranslationFailure(err));
    };
    if (active) {
      update.mutate(toRequest(choice), { onSuccess: done, onError: fail });
      return;
    }
    start.mutate(toRequest(choice), {
      onSuccess: () => {
        // Starting again begins a clean transcript.
        setLive((prev) => cleared(prev, callId));
        done();
      },
      onError: fail,
    });
  };

  const onStop = () => {
    setFailure(null);
    stop.mutate(undefined, { onError: (err) => setFailure(deskCallTranslationFailure(err)) });
  };

  return (
    <div className="mb-4 w-full space-y-2" data-testid="desk-call-translation">
      {failure && (
        <InfoBanner variant={failure === 'noCredits' ? 'warning' : 'danger'} data-testid="call-translation-error">
          {t.errors[failure]}
        </InfoBanner>
      )}
      {stoppedBySystem && !active && <CallTranslationStoppedBanner reason={mine?.stoppedReason ?? null} />}

      {active ? (
        <CallCaptionsPanel
          lines={mine?.lines ?? []}
          callerLanguage={callerLanguage}
          speakAvailable={speakAvailable}
          speakToCaller={state?.speakToCaller ?? true}
          stopping={stop.isPending}
          onChange={() => setDialogOpen(true)}
          onStop={onStop}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setDialogOpen(true)}
          data-testid="call-translate-button"
        >
          <Languages className="mr-2 h-4 w-4" />
          {t.action.translate}
        </Button>
      )}

      {dialogOpen && (
        <CallTranslationDialog
          open
          onOpenChange={setDialogOpen}
          initial={initial}
          editing={active}
          pending={start.isPending || update.isPending}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
