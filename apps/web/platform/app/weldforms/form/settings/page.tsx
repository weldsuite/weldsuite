/**
 * The form's Settings tab, laid out as WeldFlow's project settings: a column
 * of sections on the left and the open section on the right. Respondents
 * (who may respond and how often), Responses (partial responses, open and
 * close dates, the limit, the closed message), Embedding (allowed domains),
 * Access (who may see the form), the member's own notifications and the
 * danger zone. The open section is kept in the URL (`?section=`).
 */

import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { FormAccessEntry, FormAccessRole, FormRespondentMode, FormSubscriptionMode } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DateTimePicker } from '@weldsuite/ui/components/date-time-picker';
import { FormField } from '@weldsuite/ui/components/form-field';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useDeleteForm, useFormAccess, useFormSubscription, useSetFormAccess, useSetFormSubscription } from '@/hooks/queries/use-weldforms-queries';
import { OptionSelect, ToggleRow } from '../../components/prop-controls';
import { dateToIso, isoToDate } from '../../lib/datetime';
import { parseDomains } from '../../lib/embed-domains';
import { useFormsMembers } from '../../lib/use-members';
import { useFormEditor } from '../editor-context';

type SectionId = 'respondents' | 'responses' | 'embed' | 'access' | 'notifications' | 'danger';

interface SettingsSection {
  id: SectionId;
  label: string;
  description?: string;
}

export default function FormSettingsTab() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const { canEdit, form } = useFormEditor();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();

  const sections: SettingsSection[] = [
    { id: 'respondents', label: ts.respondents, description: ts.respondentsDescription },
    { id: 'responses', label: ts.responses, description: ts.responsesDescription },
    { id: 'embed', label: ts.embed, description: ts.embedDescription },
    { id: 'access', label: ts.access, description: ts.accessDescription },
    // Notifications are about responses: forms-api refuses the setting to a member who can't read them.
    ...(form.permissions.readResponses ? [{ id: 'notifications' as const, label: ts.notifications, description: ts.notificationsDescription }] : []),
    ...(form.permissions.delete ? [{ id: 'danger' as const, label: ts.danger }] : []),
  ];
  const active = sections.find((section) => section.id === search.section) ?? sections[0];

  const select = (id: string) =>
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>): Record<string, unknown> => ({ ...prev, section: id }),
    });

  return (
    <div className="relative flex h-full justify-center overflow-y-auto">
      {/* As tall as the content (at least the tab), so the section column and its divider run to the bottom. */}
      <div className="relative flex min-h-full w-full max-w-[1150px] self-start">
        <nav className="hidden border-r border-border pt-8 pb-6 md:flex md:w-60 md:shrink-0 md:pl-8" aria-label={t.weldforms.tabs.settings}>
          <div className="sticky top-8 w-full self-start">
            <h2 className="mb-4 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase">{t.weldforms.tabs.settings}</h2>
            <div className="flex flex-col gap-1">
              {sections.map((section) => {
                const isActive = section.id === active.id;
                return (
                  <Button
                    key={section.id}
                    type="button"
                    variant="ghost"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => select(section.id)}
                    className={cn(
                      '-ml-3 mr-3 cursor-pointer justify-start rounded-lg border-none px-3 py-2 text-left text-sm transition-all',
                      isActive ? 'bg-accent font-medium text-foreground' : 'font-normal text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {section.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </nav>

        <div className="min-w-0 flex-1 p-4 md:p-6 md:pl-8">
          {/* Below md the column is hidden; the sections are picked here instead. */}
          <div className="mb-6 md:hidden">
            <Select value={active.id} onValueChange={select}>
              <SelectTrigger className="w-full" aria-label={t.weldforms.tabs.settings}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sections.map((section) => (
                  <SelectItem key={section.id} value={section.id}>
                    {section.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!canEdit && (
            <div className="mb-6">
              <InfoBanner variant="info">{t.weldforms.editor.readOnly}</InfoBanner>
            </div>
          )}

          <div className="pb-8">
            <h2 className="text-lg font-semibold">{active.label}</h2>
            {active.description && <p className="mt-0.5 text-sm text-muted-foreground">{active.description}</p>}
          </div>

          <div className="max-w-3xl space-y-5 pb-10">
            {active.id === 'respondents' && <RespondentsSection />}
            {active.id === 'responses' && <ResponsesSection />}
            {active.id === 'embed' && <EmbedSection />}
            {active.id === 'access' && <AccessSection />}
            {active.id === 'notifications' && <NotificationsSection />}
            {active.id === 'danger' && <DangerSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function RespondentsSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const editor = useFormEditor();
  const { settings, canEdit } = editor;
  const disabled = !canEdit;
  const mode = settings.respondentMode;
  let onePerLabel = ts.onePerBrowser;
  if (mode === 'members') onePerLabel = ts.onePerMember;
  else if (mode === 'verified_email') onePerLabel = ts.onePerEmail;

  return (
    <>
      <OptionSelect
        label={ts.respondentMode}
        value={mode}
        disabled={disabled}
        options={(['anyone', 'verified_email', 'members'] as FormRespondentMode[]).map((m) => ({ value: m, label: ts.modes[m].label }))}
        helpText={ts.modes[mode].help}
        onChange={(respondentMode) =>
          editor.patchSettings({
            respondentMode,
            // Options that only exist in one mode are switched off when leaving it.
            ...(respondentMode !== 'verified_email' ? { allowEdit: false } : {}),
            ...(respondentMode !== 'members' ? { hideMemberIdentity: false } : {}),
            ...(respondentMode === 'anyone' ? { sendReceipt: false } : {}),
          })
        }
      />
      <ToggleRow
        id="settings-one-per"
        label={onePerLabel}
        description={mode === 'anyone' ? ts.onePerBrowserNote : undefined}
        checked={settings.onePerRespondent}
        disabled={disabled}
        onCheckedChange={(onePerRespondent) => editor.patchSettings({ onePerRespondent })}
      />
      {mode === 'verified_email' && (
        <ToggleRow id="settings-allow-edit" label={ts.allowEdit} description={ts.allowEditHelp} checked={settings.allowEdit} disabled={disabled} onCheckedChange={(allowEdit) => editor.patchSettings({ allowEdit })} />
      )}
      {mode === 'members' && (
        <ToggleRow id="settings-hide-identity" label={ts.hideIdentity} description={ts.hideIdentityHelp} checked={settings.hideMemberIdentity} disabled={disabled} onCheckedChange={(hideMemberIdentity) => editor.patchSettings({ hideMemberIdentity })} />
      )}
      <ToggleRow
        id="settings-receipt"
        label={ts.sendReceipt}
        description={mode === 'anyone' ? ts.sendReceiptVerifiedOnly : ts.sendReceiptHelp}
        checked={settings.sendReceipt}
        disabled={disabled || mode === 'anyone'}
        onCheckedChange={(sendReceipt) => editor.patchSettings({ sendReceipt })}
      />
    </>
  );
}

function ResponsesSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const { dateFnsLocale } = useDateLocale();
  const editor = useFormEditor();
  const { settings, canEdit } = editor;
  const disabled = !canEdit;

  return (
    <>
      <ToggleRow id="settings-partial" label={ts.collectPartial} description={ts.collectPartialHelp} checked={settings.collectPartial} disabled={disabled} onCheckedChange={(collectPartial) => editor.patchSettings({ collectPartial })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={ts.opensAt}>
          <DateTimePicker
            id="settings-opens-at"
            value={isoToDate(settings.opensAt)}
            onChange={(date) => editor.patchSettings({ opensAt: dateToIso(date) })}
            placeholder={ts.noDate}
            timeLabel={ts.openingTime}
            locale={dateFnsLocale}
            disabled={disabled}
          />
        </FormField>
        <FormField label={ts.closesAt}>
          <DateTimePicker
            id="settings-closes-at"
            value={isoToDate(settings.closesAt)}
            onChange={(date) => editor.patchSettings({ closesAt: dateToIso(date) })}
            placeholder={ts.noDate}
            timeLabel={ts.closingTime}
            defaultTime="23:59"
            locale={dateFnsLocale}
            disabled={disabled}
          />
        </FormField>
      </div>
      <FormField label={ts.responseLimit} helpText={ts.responseLimitHelp}>
        <NumberInput value={settings.responseLimit ?? undefined} onValueChange={(value) => editor.patchSettings({ responseLimit: value === undefined ? null : Math.max(1, Math.floor(value)) })} min={1} disabled={disabled} placeholder={ts.noLimit} className="w-40" />
      </FormField>
      <FormField label={ts.closedMessage} helpText={ts.closedMessageHelp}>
        <Textarea value={settings.closedMessage ?? ''} onChange={(e) => editor.patchSettings({ closedMessage: e.target.value === '' ? null : e.target.value })} rows={2} maxLength={1000} disabled={disabled} />
      </FormField>
    </>
  );
}

function EmbedSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const editor = useFormEditor();
  const { settings, canEdit } = editor;
  const [domainsText, setDomainsText] = useState<string | null>(null);
  const domainsShown = domainsText ?? settings.allowedEmbedDomains.join('\n');
  const parsed = parseDomains(domainsShown);

  return (
    <FormField label={ts.allowedDomains} helpText={ts.allowedDomainsHelp} error={parsed.invalid.length > 0 ? ts.invalidDomains.replace('{domains}', parsed.invalid.join(', ')) : undefined}>
      <Textarea
        value={domainsShown}
        onChange={(e) => {
          setDomainsText(e.target.value);
          editor.patchSettings({ allowedEmbedDomains: parseDomains(e.target.value).domains.slice(0, 50) });
        }}
        onBlur={() => setDomainsText(null)}
        rows={3}
        placeholder="example.com"
        disabled={!canEdit}
        className="font-mono text-xs"
      />
    </FormField>
  );
}

function AccessSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const editor = useFormEditor();
  const { form } = editor;
  const restricted = editor.draft.access === 'restricted';
  const canManage = form.permissions.manageAccess;
  const access = useFormAccess(form.id, restricted);
  const setAccess = useSetFormAccess(form.id);
  const { members } = useFormsMembers();
  const [pickerOpen, setPickerOpen] = useState(false);

  const entries: FormAccessEntry[] = access.data ?? [];
  const taken = new Set([form.owner.userId, ...entries.map((e) => e.user.userId)]);
  const candidates = members.filter((m) => !taken.has(m.userId));

  async function save(next: Array<{ userId: string; role: FormAccessRole }>) {
    try {
      await setAccess.mutateAsync({ entries: next });
    } catch {
      toast.error(ts.accessSaveFailed);
    }
  }
  const asInput = (list: FormAccessEntry[]) => list.map((e) => ({ userId: e.user.userId, role: e.role }));

  return (
    <>
      <OptionSelect
        label={ts.whoCanOpen}
        value={editor.draft.access}
        disabled={!canManage || !editor.canEdit}
        options={[
          { value: 'workspace', label: ts.accessWorkspace },
          { value: 'restricted', label: ts.accessRestricted },
        ]}
        helpText={restricted ? ts.accessRestrictedHelp : ts.accessWorkspaceHelp}
        onChange={(value) => editor.editDraft((d) => ({ ...d, access: value }))}
      />
      {restricted && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{form.owner.name ?? form.owner.email}</span>
            <span className="text-xs text-muted-foreground">{ts.owner}</span>
          </div>
          {entries.map((entry) => (
            <div key={entry.user.userId} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{entry.user.name ?? entry.user.email}</span>
              <Select
                value={entry.role}
                disabled={!canManage}
                onValueChange={(role) => void save(asInput(entries).map((e) => (e.userId === entry.user.userId ? { ...e, role: role as FormAccessRole } : e)))}
              >
                <SelectTrigger size="sm" className="h-8 w-36" aria-label={ts.role}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">{ts.roleEditor}</SelectItem>
                  <SelectItem value="results">{ts.roleResults}</SelectItem>
                </SelectContent>
              </Select>
              {canManage && (
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => void save(asInput(entries).filter((e) => e.userId !== entry.user.userId))} aria-label={t.common.actions.remove}>
                  <X />
                </Button>
              )}
            </div>
          ))}
          {canManage && (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={candidates.length === 0}>
                  <UserPlus className="size-4" />
                  {ts.addMember}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="max-h-64 w-72 overflow-y-auto p-1">
                {candidates.map((member) => (
                  <button
                    key={member.userId}
                    type="button"
                    className="flex w-full flex-col rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setPickerOpen(false);
                      void save([...asInput(entries), { userId: member.userId, role: 'editor' }]);
                    }}
                  >
                    <span className="truncate">{member.name}</span>
                    {member.email && member.email !== member.name && <span className="truncate text-xs text-muted-foreground">{member.email}</span>}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <p className="text-xs text-muted-foreground">{ts.manageAlways}</p>
        </div>
      )}
    </>
  );
}

function NotificationsSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const { form } = useFormEditor();
  const subscription = useFormSubscription(form.id, form.permissions.readResponses);
  const setSubscription = useSetFormSubscription(form.id);
  const mode = subscription.data?.mode ?? 'off';
  return (
    <OptionSelect
      label={ts.notifyMe}
      value={mode}
      disabled={subscription.isLoading || setSubscription.isPending}
      options={(['instant', 'daily', 'off'] as FormSubscriptionMode[]).map((m) => ({ value: m, label: ts.notifyModes[m] }))}
      onChange={(next) => {
        setSubscription.mutate({ mode: next }, { onError: () => toast.error(ts.notifySaveFailed) });
      }}
    />
  );
}

function DangerSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const router = useRouter();
  const { form } = useFormEditor();
  const remove = useDeleteForm();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/40 p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{ts.deleteForm}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{ts.dangerDescription}</p>
      </div>
      <Button type="button" variant="destructive" className="shrink-0" onClick={() => setConfirming(true)}>
        <Trash2 className="size-4" />
        {t.common.actions.delete}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t.weldforms.actions.deleteConfirmTitle}
        description={t.weldforms.actions.deleteConfirmDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        onConfirm={async () => {
          try {
            await remove.mutateAsync(form.id);
            toast.success(t.weldforms.actions.deleted);
            router.push('/weldforms');
          } catch {
            toast.error(t.weldforms.actions.deleteFailed);
            setConfirming(false);
          }
        }}
      />
    </div>
  );
}
