/**
 * The form's Settings tab: who may respond and how often, partial responses,
 * open and close dates, the response limit, the closed message, embed
 * domains, who may see the form (access), the member's own notifications and
 * the danger zone.
 */

import { useState } from 'react';
import { Trash2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { FormAccessEntry, FormAccessRole, FormRespondentMode, FormSubscriptionMode } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { FormField } from '@weldsuite/ui/components/form-field';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useDeleteForm, useFormAccess, useFormSubscription, useSetFormAccess, useSetFormSubscription } from '@/hooks/queries/use-weldforms-queries';
import { OptionSelect, ToggleRow } from '../../components/prop-controls';
import { isoToLocalInput, localInputToIso } from '../../lib/datetime';
import { parseDomains } from '../../lib/embed-domains';
import { useFormsMembers } from '../../lib/use-members';
import { useFormEditor } from '../editor-context';

function Section({ title, description, children }: Readonly<{ title: string; description?: string; children: React.ReactNode }>) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export default function FormSettingsTab() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const editor = useFormEditor();
  const { settings, canEdit, form } = editor;
  const disabled = !canEdit;
  const mode = settings.respondentMode;
  let onePerLabel = ts.onePerBrowser;
  if (mode === 'members') onePerLabel = ts.onePerMember;
  else if (mode === 'verified_email') onePerLabel = ts.onePerEmail;

  const [domainsText, setDomainsText] = useState<string | null>(null);
  const domainsShown = domainsText ?? settings.allowedEmbedDomains.join('\n');
  const parsed = parseDomains(domainsShown);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-4 pb-10">
        {!canEdit && <InfoBanner variant="info">{t.weldforms.editor.readOnly}</InfoBanner>}

        <Section title={ts.respondents} description={ts.respondentsDescription}>
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
        </Section>

        <Section title={ts.responses} description={ts.responsesDescription}>
          <ToggleRow id="settings-partial" label={ts.collectPartial} description={ts.collectPartialHelp} checked={settings.collectPartial} disabled={disabled} onCheckedChange={(collectPartial) => editor.patchSettings({ collectPartial })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={ts.opensAt}>
              <Input type="datetime-local" value={isoToLocalInput(settings.opensAt)} onChange={(e) => editor.patchSettings({ opensAt: localInputToIso(e.target.value) })} disabled={disabled} />
            </FormField>
            <FormField label={ts.closesAt}>
              <Input type="datetime-local" value={isoToLocalInput(settings.closesAt)} onChange={(e) => editor.patchSettings({ closesAt: localInputToIso(e.target.value) })} disabled={disabled} />
            </FormField>
          </div>
          <FormField label={ts.responseLimit} helpText={ts.responseLimitHelp}>
            <NumberInput value={settings.responseLimit ?? undefined} onValueChange={(value) => editor.patchSettings({ responseLimit: value === undefined ? null : Math.max(1, Math.floor(value)) })} min={1} disabled={disabled} placeholder={ts.noLimit} className="w-40" />
          </FormField>
          <FormField label={ts.closedMessage} helpText={ts.closedMessageHelp}>
            <Textarea value={settings.closedMessage ?? ''} onChange={(e) => editor.patchSettings({ closedMessage: e.target.value === '' ? null : e.target.value })} rows={2} maxLength={1000} disabled={disabled} />
          </FormField>
        </Section>

        <Section title={ts.embed} description={ts.embedDescription}>
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
              disabled={disabled}
              className="font-mono text-xs"
            />
          </FormField>
        </Section>

        <AccessSection />
        <NotificationsSection />

        {form.permissions.delete && <DangerSection />}
      </div>
    </div>
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
    <Section title={ts.access} description={ts.accessDescription}>
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
    </Section>
  );
}

function NotificationsSection() {
  const { t } = useI18n();
  const ts = t.weldforms.formSettings;
  const { form } = useFormEditor();
  // Notifications are about responses: forms-api refuses the setting to a member who can't read them.
  const canReadResponses = form.permissions.readResponses;
  const subscription = useFormSubscription(form.id, canReadResponses);
  const setSubscription = useSetFormSubscription(form.id);
  if (!canReadResponses) return null;
  const mode = subscription.data?.mode ?? 'off';
  return (
    <Section title={ts.notifications} description={ts.notificationsDescription}>
      <OptionSelect
        label={ts.notifyMe}
        value={mode}
        disabled={subscription.isLoading || setSubscription.isPending}
        options={(['instant', 'daily', 'off'] as FormSubscriptionMode[]).map((m) => ({ value: m, label: ts.notifyModes[m] }))}
        onChange={(next) => {
          setSubscription.mutate({ mode: next }, { onError: () => toast.error(ts.notifySaveFailed) });
        }}
      />
    </Section>
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
    <section className="space-y-3 rounded-lg border border-destructive/40 p-4">
      <div>
        <h2 className="text-sm font-semibold text-destructive">{ts.danger}</h2>
        <p className="text-sm text-muted-foreground">{ts.dangerDescription}</p>
      </div>
      <Button type="button" variant="destructive" size="sm" onClick={() => setConfirming(true)}>
        <Trash2 className="size-4" />
        {ts.deleteForm}
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
    </section>
  );
}
