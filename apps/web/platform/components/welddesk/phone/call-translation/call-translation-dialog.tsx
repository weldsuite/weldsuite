import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  CALL_TRANSLATION_LANGUAGES,
  callTranslationTtsLocale,
  type StartCallTranslation,
} from '@weldsuite/core-api-client/schemas/desk-call-translation';
import { getTranslations } from '@/lib/i18n';
import { languageName } from './call-translation-labels';

export interface CallTranslationChoice {
  callerLanguage: string;
  agentLanguage: string;
  speakToCaller: boolean;
}

/** `auto` in the picker while the caller's language is still to be detected. */
export const DETECT = 'auto';

/** Whether the agent's words can be spoken to a caller of `callerLanguage` (`auto` is not known yet). */
export function canSpeakTo(callerLanguage: string): boolean {
  return callerLanguage !== DETECT && callTranslationTtsLocale(callerLanguage) !== null;
}

export function toRequest(choice: CallTranslationChoice): StartCallTranslation {
  return {
    callerLanguage: choice.callerLanguage as StartCallTranslation['callerLanguage'],
    agentLanguage: choice.agentLanguage as StartCallTranslation['agentLanguage'],
    speakToCaller: choice.speakToCaller,
  };
}

/**
 * Pick the caller's language (default "Detect"), your own and whether your
 * translated words are spoken to the caller. The same dialog starts a
 * translation and changes a running one.
 */
export function CallTranslationDialog({
  open,
  onOpenChange,
  initial,
  editing,
  pending,
  onSubmit,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: CallTranslationChoice;
  editing: boolean;
  pending: boolean;
  onSubmit: (choice: CallTranslationChoice) => void;
}>) {
  const t = getTranslations('deskCallTranslation');
  const [choice, setChoice] = useState<CallTranslationChoice>(initial);
  const speakable = canSpeakTo(choice.callerLanguage);

  let speakHint: string = t.dialog.speakHint;
  if (choice.callerLanguage === DETECT) speakHint = t.dialog.speakUnknown;
  else if (!speakable) {
    speakHint = t.dialog.speakUnavailable.replace('{language}', languageName(t, choice.callerLanguage));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="call-translation-dialog">
        <DialogHeader>
          <DialogTitle>{t.dialog.title}</DialogTitle>
          <DialogDescription>{t.dialog.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="call-translation-caller">{t.dialog.callerLanguage}</Label>
            <Select value={choice.callerLanguage} onValueChange={(callerLanguage) => setChoice({ ...choice, callerLanguage })}>
              <SelectTrigger id="call-translation-caller" data-testid="call-translation-caller">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DETECT}>{t.dialog.detect}</SelectItem>
                {CALL_TRANSLATION_LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {languageName(t, language.code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {choice.callerLanguage === DETECT && <p className="text-xs text-muted-foreground">{t.dialog.detectHint}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="call-translation-agent">{t.dialog.agentLanguage}</Label>
            <Select value={choice.agentLanguage} onValueChange={(agentLanguage) => setChoice({ ...choice, agentLanguage })}>
              <SelectTrigger id="call-translation-agent" data-testid="call-translation-agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALL_TRANSLATION_LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {languageName(t, language.code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="call-translation-speak">{t.dialog.speakToCaller}</Label>
              <p className="text-xs text-muted-foreground" data-testid="call-translation-speak-hint">
                {speakHint}
              </p>
            </div>
            <Switch
              id="call-translation-speak"
              data-testid="call-translation-speak"
              checked={speakable && choice.speakToCaller}
              disabled={!speakable}
              onCheckedChange={(speakToCaller) => setChoice({ ...choice, speakToCaller })}
            />
          </div>

          <p className="text-xs text-muted-foreground">{t.dialog.cost}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.dialog.cancel}
          </Button>
          <Button onClick={() => onSubmit(choice)} disabled={pending} data-testid="call-translation-submit">
            {editing ? t.dialog.save : t.dialog.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
