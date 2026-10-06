import { Switch } from '@weldsuite/ui/components/switch';
import { formatLabel, type MeetingToolsLabels } from '../../tools/labels';
import type { ToolsPrefs } from '../../tools/tools-store';
import {
  TRANSLATION_LANGUAGES,
  isTranslationSupported,
  languageName,
  prepareTranslation,
  type TranslationStatus,
} from '../../tools/translation';

export interface TranslationToolProps {
  prefs: ToolsPrefs;
  onPrefsChange: (patch: Partial<ToolsPrefs>) => void;
  status: TranslationStatus;
  labels: MeetingToolsLabels;
}

const SELECT_CLASS =
  'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 dark:border-input';

function statusText(status: TranslationStatus, target: string, labels: MeetingToolsLabels): string | null {
  const t = labels.translation;
  switch (status.phase) {
    case 'preparing':
      return t.preparing;
    case 'downloading':
      return formatLabel(t.downloading, { percent: status.percent });
    case 'ready':
      return formatLabel(t.ready, { language: languageName(target) });
    case 'pair-unavailable':
      return t.pairUnavailable;
    case 'failed':
      return t.failed;
    default:
      return null;
  }
}

export function TranslationTool({ prefs, onPrefsChange, status, labels }: TranslationToolProps) {
  const t = labels.translation;
  const supported = isTranslationSupported();
  const message = statusText(status, prefs.translateTo, labels);

  // The first use of a language pair downloads a language pack, which the
  // browser only allows right after a click: start the load from the handler
  // itself, before the state change that the caption translation reacts to.
  const warmUp = (from: string, to: string) => {
    void prepareTranslation(from, to).catch(() => undefined);
  };

  return (
    <div className="p-4 space-y-5">
      <p className="text-sm text-muted-foreground">{t.intro}</p>

      {!supported ? (
        <p className="rounded-xl bg-muted/40 px-3 py-2.5 text-sm">{t.unsupported}</p>
      ) : (
        <>
          <label className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2.5">
            <span className="text-sm font-medium">{t.enable}</span>
            <Switch
              checked={prefs.translationEnabled}
              onCheckedChange={(on) => {
                if (on) warmUp(prefs.translateFrom, prefs.translateTo);
                onPrefsChange({ translationEnabled: on });
              }}
              aria-label={t.enable}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">{t.spokenLanguage}</span>
              <select
                className={SELECT_CLASS}
                value={prefs.translateFrom}
                onChange={(e) => {
                  if (prefs.translationEnabled) warmUp(e.target.value, prefs.translateTo);
                  onPrefsChange({ translateFrom: e.target.value });
                }}
              >
                {TRANSLATION_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">{t.targetLanguage}</span>
              <select
                className={SELECT_CLASS}
                value={prefs.translateTo}
                onChange={(e) => {
                  if (prefs.translationEnabled) warmUp(prefs.translateFrom, e.target.value);
                  onPrefsChange({ translateTo: e.target.value });
                }}
              >
                {TRANSLATION_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
