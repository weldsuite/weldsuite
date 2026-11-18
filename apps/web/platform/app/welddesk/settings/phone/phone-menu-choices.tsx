/**
 * The keypad menu: its prompt, its choices (a key, a label, an action and the
 * target the action needs) and the "when the caller presses nothing" choice.
 */

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { DeskTeam } from '@/hooks/queries/use-desk-routing-queries';
import type { DeskPhoneVoiceAgent } from '@/hooks/queries/use-desk-phone-settings-queries';
import {
  DESK_PHONE_MENU_DIGITS,
  MAX_MENU_CHOICES,
  MENU_CHOICE_ACTIONS,
  emptyChoice,
  unusedDigits,
  type FormErrors,
  type MenuChoiceAction,
  type MenuChoiceValues,
  type MenuDigit,
  type PhoneRouteFormValues,
} from './phone-route-form';
import {
  Field,
  NONE,
  SpokenTextField,
  TeamSelect,
  VoiceAgentSelect,
  errorText,
  type PhoneSettingsStrings,
} from './phone-route-fields';

export function MenuEditor({
  values,
  set,
  errors,
  teams,
  agents,
  t,
}: Readonly<{
  values: PhoneRouteFormValues;
  set: <K extends keyof PhoneRouteFormValues>(key: K, value: PhoneRouteFormValues[K]) => void;
  errors: FormErrors;
  teams: DeskTeam[];
  agents: DeskPhoneVoiceAgent[];
  t: PhoneSettingsStrings;
}>) {
  const choices = values.menuChoices;
  const free = unusedDigits(choices);

  const patchChoice = (index: number, patch: Partial<MenuChoiceValues>) => {
    const next = choices.map((choice, i) => (i === index ? { ...choice, ...patch } : choice));
    set('menuChoices', next);
    // The fallback follows its choice when that choice moves to another key.
    const previous = choices[index];
    if (patch.digit && previous && values.fallbackDigit === previous.digit) set('fallbackDigit', patch.digit);
  };

  const removeChoice = (index: number) => {
    const removed = choices[index];
    set('menuChoices', choices.filter((_, i) => i !== index));
    if (removed && values.fallbackDigit === removed.digit) set('fallbackDigit', '');
  };

  const addChoice = () => {
    const digit = free[0];
    if (digit) set('menuChoices', [...choices, emptyChoice(digit)]);
  };

  const nameOf = (choice: MenuChoiceValues) => choice.label.trim() || t.menu.choiceActions[choice.action];

  return (
    <div className="space-y-6" data-testid="phone-menu-editor">
      <SpokenTextField
        id="phone-menu-prompt"
        label={t.menu.prompt}
        hint={t.menu.promptHint}
        value={values.menuPrompt}
        onChange={(v) => set('menuPrompt', v)}
        error={errorText(errors.menuPrompt, t)}
        rows={3}
      />

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium">{t.menu.choices}</h3>
            <p className="text-sm text-muted-foreground">{t.menu.choicesHint}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addChoice}
            disabled={choices.length >= MAX_MENU_CHOICES || free.length === 0}
            data-testid="menu-add-choice"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t.menu.addChoice}
          </Button>
        </div>
        {choices.length === 0 && <p className="text-sm text-muted-foreground">{t.menu.noChoices}</p>}
        {errors.menuChoices && (
          <p className="text-sm text-destructive" role="alert">
            {errorText(errors.menuChoices, t)}
          </p>
        )}
        {choices.map((choice, index) => {
          const key = `choice.${index}`;
          const digits = DESK_PHONE_MENU_DIGITS.filter((d) => d === choice.digit || free.includes(d));
          return (
            <div key={choice.uid} className="space-y-3 rounded-lg border p-4" data-testid="menu-choice">
              <div className="grid gap-3 sm:grid-cols-[6rem_1fr_auto]">
                <Field label={t.menu.digit} error={errorText(errors[`${key}.digit`], t)}>
                  <Select value={choice.digit} onValueChange={(v) => v && patchChoice(index, { digit: v as MenuDigit })}>
                    <SelectTrigger aria-label={`${t.menu.digit} ${index + 1}`} aria-invalid={Boolean(errors[`${key}.digit`])}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {digits.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t.menu.label} htmlFor={`menu-label-${index}`} error={errorText(errors[`${key}.label`], t, `${key}.label`)}>
                  <Input
                    id={`menu-label-${index}`}
                    value={choice.label}
                    maxLength={100}
                    placeholder={t.menu.labelPlaceholder}
                    onChange={(e) => patchChoice(index, { label: e.target.value })}
                  />
                </Field>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t.menu.removeChoice.replace('{digit}', choice.digit)}
                    onClick={() => removeChoice(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t.menu.action}>
                  <Select value={choice.action} onValueChange={(v) => v && patchChoice(index, { action: v as MenuChoiceAction })}>
                    <SelectTrigger aria-label={`${t.menu.action} ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MENU_CHOICE_ACTIONS.map((action) => (
                        <SelectItem key={action} value={action}>
                          {t.menu.choiceActions[action]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {choice.action === 'ai_agent' && (
                  <VoiceAgentSelect
                    value={choice.voiceAgentId}
                    onChange={(v) => patchChoice(index, { voiceAgentId: v })}
                    agents={agents}
                    t={t}
                    label={`${t.fields.voiceAgent} ${index + 1}`}
                    error={errorText(errors[`${key}.voiceAgentId`], t)}
                  />
                )}
                {choice.action === 'agents' && (
                  <TeamSelect
                    value={choice.departmentId}
                    onChange={(v) => patchChoice(index, { departmentId: v })}
                    teams={teams}
                    t={t}
                    label={`${t.fields.team} ${index + 1}`}
                    error={errorText(errors[`${key}.departmentId`], t)}
                  />
                )}
                {choice.action === 'forward' && (
                  <Field
                    label={t.fields.forwardTo}
                    htmlFor={`menu-forward-${index}`}
                    hint={t.fields.forwardToHint}
                    error={errorText(errors[`${key}.forwardToE164`], t)}
                  >
                    <Input
                      id={`menu-forward-${index}`}
                      value={choice.forwardToE164}
                      placeholder="+15551234567"
                      onChange={(e) => patchChoice(index, { forwardToE164: e.target.value })}
                      aria-invalid={Boolean(errors[`${key}.forwardToE164`])}
                    />
                  </Field>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <Field label={t.menu.fallback} hint={t.menu.fallbackHint} error={errorText(errors.fallbackDigit, t)}>
        <Select
          value={values.fallbackDigit || NONE}
          onValueChange={(v) => set('fallbackDigit', v === NONE ? '' : (v as MenuDigit))}
        >
          <SelectTrigger aria-label={t.menu.fallback} aria-invalid={Boolean(errors.fallbackDigit)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t.menu.fallbackHangup}</SelectItem>
            {choices.map((choice) => (
              <SelectItem key={choice.digit} value={choice.digit}>
                {t.menu.fallbackChoice.replace('{digit}', choice.digit).replace('{name}', nameOf(choice))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
