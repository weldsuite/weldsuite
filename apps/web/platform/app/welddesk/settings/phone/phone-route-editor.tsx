/**
 * Edit the inbound route of one phone number in a side sheet. Shows only the
 * fields of the chosen action: ring agents, keypad menu, voicemail, AI voice
 * agent, forward or hang up.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { getTranslations } from '@/lib/i18n';
import type { DeskTeam } from '@/hooks/queries/use-desk-routing-queries';
import {
  useSaveDeskPhoneRoute,
  type DeskPhoneNumber,
  type DeskPhoneRoute,
  type DeskPhoneVoiceAgent,
} from '@/hooks/queries/use-desk-phone-settings-queries';
import {
  ROUTE_ACTIONS,
  routeToValues,
  serverErrorToFormErrors,
  usesQueue,
  usesVoicemail,
  validateValues,
  valuesToInput,
  type FormErrors,
  type PhoneRouteFormValues,
} from './phone-route-form';
import {
  Field,
  LanguageField,
  QueueFields,
  SpokenTextField,
  TeamSelect,
  VoiceAgentSelect,
  errorText,
  type PhoneSettingsStrings,
} from './phone-route-fields';
import { MenuEditor } from './phone-menu-choices';

export interface PhoneRouteEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The number being edited; null while the sheet is closed. */
  number: DeskPhoneNumber | null;
  route: DeskPhoneRoute | undefined;
  teams: DeskTeam[];
  agents: DeskPhoneVoiceAgent[];
  /** Whether the member may change routes (`settings:manage`). */
  canEdit: boolean;
}

export function PhoneRouteEditor({ open, onOpenChange, number, route, teams, agents, canEdit }: Readonly<PhoneRouteEditorProps>) {
  const t = getTranslations('helpdesk').phoneSettings;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="phone-route-editor">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{t.editor.title.replace('{name}', number?.displayName || number?.phoneNumber || '')}</SheetTitle>
          <SheetDescription>{t.editor.description}</SheetDescription>
        </SheetHeader>
        {open && number && (
          <PhoneRouteForm
            key={number.id}
            number={number}
            route={route}
            teams={teams}
            agents={agents}
            canEdit={canEdit}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

export function PhoneRouteForm({
  number,
  route,
  teams,
  agents,
  canEdit,
  onClose,
}: Readonly<{
  number: DeskPhoneNumber;
  route: DeskPhoneRoute | undefined;
  teams: DeskTeam[];
  agents: DeskPhoneVoiceAgent[];
  canEdit: boolean;
  onClose: () => void;
}>) {
  const t: PhoneSettingsStrings = getTranslations('helpdesk').phoneSettings;
  const save = useSaveDeskPhoneRoute();
  const [values, setValues] = useState<PhoneRouteFormValues>(() => routeToValues(route));
  const [errors, setErrors] = useState<FormErrors>({});

  const set = <K extends keyof PhoneRouteFormValues>(key: K, value: PhoneRouteFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const found = validateValues(number.id, values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await save.mutateAsync(valuesToInput(number.id, values));
      toast.success(t.editor.saved);
      onClose();
    } catch (err) {
      const failure = err as { status?: number; body?: unknown; message?: string };
      const mapped = serverErrorToFormErrors(values, {
        status: failure.status,
        body: failure.body,
        message: failure.message ?? t.editor.saveFailed,
      });
      setErrors(mapped);
      toast.error(t.editor.saveFailed);
    }
  };

  const action = values.action;
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-testid="phone-route-form"
    >
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
        {!canEdit && <InfoBanner variant="neutral">{t.editor.readOnly}</InfoBanner>}
        <fieldset disabled={!canEdit || save.isPending} className="space-y-6">
          <Field label={t.fields.action} hint={t.actionHints[action]}>
            <Select value={action} onValueChange={(v) => set('action', v as PhoneRouteFormValues['action'])}>
              <SelectTrigger aria-label={t.fields.action}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUTE_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t.actions[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {action === 'agents' && (
            <div className="space-y-6" data-testid="phone-fields-agents">
              <TeamSelect
                value={values.departmentId}
                onChange={(v) => set('departmentId', v)}
                teams={teams}
                t={t}
                label={t.fields.team}
                hint={t.fields.teamHint}
                error={errorText(errors.departmentId, t)}
              />
              <SpokenTextField
                id="phone-greeting"
                label={t.fields.greeting}
                hint={t.fields.greetingHint}
                value={values.greeting}
                onChange={(v) => set('greeting', v)}
                error={errorText(errors.greeting, t)}
              />
              <LanguageField value={values.language} onChange={(v) => set('language', v)} t={t} error={errorText(errors.language, t)} />
              <QueueFields values={values} set={set} errors={errors} t={t} />
            </div>
          )}

          {action === 'voicemail' && (
            <div className="space-y-6" data-testid="phone-fields-voicemail">
              <LanguageField value={values.language} onChange={(v) => set('language', v)} t={t} error={errorText(errors.language, t)} />
              <QueueFields values={values} set={set} errors={errors} t={t} />
            </div>
          )}

          {action === 'menu' && (
            <div className="space-y-6" data-testid="phone-fields-menu">
              <LanguageField value={values.language} onChange={(v) => set('language', v)} t={t} error={errorText(errors.language, t)} />
              <MenuEditor values={values} set={set} errors={errors} teams={teams} agents={agents} t={t} />
              {(usesQueue(values) || usesVoicemail(values)) && (
                <section className="space-y-4">
                  <div>
                    <h3 className="font-medium">{t.menu.sharedTitle}</h3>
                    <p className="text-sm text-muted-foreground">{t.menu.sharedHint}</p>
                  </div>
                  <QueueFields values={values} set={set} errors={errors} t={t} />
                </section>
              )}
            </div>
          )}

          {action === 'ai_agent' && (
            <div data-testid="phone-fields-ai-agent">
              <VoiceAgentSelect
                value={values.voiceAgentId}
                onChange={(v) => set('voiceAgentId', v)}
                agents={agents}
                t={t}
                label={t.fields.voiceAgent}
                error={errorText(errors.voiceAgentId, t)}
              />
            </div>
          )}

          {action === 'forward' && (
            <div data-testid="phone-fields-forward">
              <Field
                label={t.fields.forwardTo}
                htmlFor="phone-forward-to"
                hint={t.fields.forwardToHint}
                error={errorText(errors.forwardToE164, t)}
              >
                <Input
                  id="phone-forward-to"
                  value={values.forwardToE164}
                  placeholder="+15551234567"
                  onChange={(e) => set('forwardToE164', e.target.value)}
                  aria-invalid={Boolean(errors.forwardToE164)}
                />
              </Field>
            </div>
          )}
        </fieldset>
        {errors.form && 'message' in errors.form && <InlineError>{errors.form.message}</InlineError>}
        {hasErrors && !errors.form && <InlineError>{t.editor.fixErrors}</InlineError>}
      </div>
      <SheetFooter className="border-t px-6 py-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          {t.editor.cancel}
        </Button>
        {canEdit && (
          <Button type="submit" disabled={save.isPending} data-testid="phone-route-save">
            {t.editor.save}
          </Button>
        )}
      </SheetFooter>
    </form>
  );
}
