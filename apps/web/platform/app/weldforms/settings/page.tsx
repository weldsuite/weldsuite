/**
 * WeldForms workspace settings: the themes library, the sender name, reminder
 * defaults for invitations, the "Made with WeldForms" badge and the month's
 * usage.
 */

import { useMemo, useState } from 'react';
import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { formThemeTokensSchema, type FormThemeTokens } from '@weldsuite/forms-engine';
import type { FormsWorkspaceSettings, FormTheme } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FormField } from '@weldsuite/ui/components/form-field';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Progress } from '@weldsuite/ui/components/progress';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCreateFormTheme,
  useDeleteFormTheme,
  useFormsSettings,
  useFormsUsage,
  useFormThemes,
  useUpdateFormsSettings,
  useUpdateFormTheme,
} from '@/hooks/queries/use-weldforms-queries';
import { FormPreview } from '../components/form-preview';
import { ToggleRow } from '../components/prop-controls';
import { ThemeSwatch, ThemeTokensEditor } from '../components/theme-tokens-editor';
import { createSampleDefinition } from '../lib/sample-definition';

const DEFAULT_TOKENS = formThemeTokensSchema.parse({});

function Section({ title, description, children, actions }: Readonly<{ title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }>) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export default function WeldFormsSettingsPage() {
  const { t, format, language } = useI18n();
  const tw = t.weldforms.workspaceSettings;
  const canManage = useCan('forms:manage');
  const settings = useFormsSettings();
  const themes = useFormThemes();
  const usage = useFormsUsage();

  if (settings.isLoading || themes.isLoading) return <PageLoader />;
  if (settings.error || !settings.data) {
    return (
      <div className="p-6">
        <ErrorState message={t.weldforms.loadFailed} onRetry={() => void settings.refetch()} retryLabel={t.common.actions.retry} />
      </div>
    );
  }

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-4 pb-10">
        <div>
          <h1 className="text-lg font-semibold">{tw.title}</h1>
          <p className="text-sm text-muted-foreground">{tw.description}</p>
        </div>
        {!canManage && <InfoBanner variant="info">{tw.readOnly}</InfoBanner>}

        <ThemesSection themes={themes.data ?? []} defaultThemeId={settings.data.defaultThemeId} canManage={canManage} />
        <GeneralSection key={JSON.stringify(settings.data)} settings={settings.data} canManage={canManage} />

        {usage.data && (
          <Section title={tw.usage} description={format(tw.usagePeriod, { from: dateFormat.format(new Date(usage.data.periodStart)), to: dateFormat.format(new Date(usage.data.periodEnd)) })}>
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span>{tw.completedResponses}</span>
                <span className="tabular-nums">{usage.data.limit === null ? format(tw.unlimited, { used: usage.data.used }) : format(tw.usedOf, { used: usage.data.used, limit: usage.data.limit })}</span>
              </div>
              {usage.data.limit !== null && <Progress value={Math.min(100, (usage.data.used / Math.max(1, usage.data.limit)) * 100)} className="h-2" aria-label={tw.completedResponses} />}
              {usage.data.plan && <p className="text-xs text-muted-foreground">{format(tw.plan, { plan: usage.data.plan })}</p>}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

function ThemesSection({ themes, defaultThemeId, canManage }: Readonly<{ themes: FormTheme[]; defaultThemeId: string | null; canManage: boolean }>) {
  const { t } = useI18n();
  const tw = t.weldforms.workspaceSettings;
  const update = useUpdateFormTheme();
  const remove = useDeleteFormTheme();
  const [editing, setEditing] = useState<FormTheme | 'new' | null>(null);
  const [deleting, setDeleting] = useState<FormTheme | null>(null);

  return (
    <Section
      title={tw.themes}
      description={tw.themesDescription}
      actions={
        canManage && (
          <Button type="button" size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            {tw.newTheme}
          </Button>
        )
      }
    >
      {themes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tw.noThemes}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {themes.map((theme) => (
            <li key={theme.id} className="flex items-center gap-3 px-3 py-2">
              <ThemeSwatch tokens={theme.tokens} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{theme.name}</span>
              {theme.id === defaultThemeId && <SoftBadge tone="success">{tw.defaultBadge}</SoftBadge>}
              {canManage && (
                <div className="flex gap-0.5">
                  {theme.id !== defaultThemeId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tw.makeDefault}
                      title={tw.makeDefault}
                      onClick={() => update.mutate({ id: theme.id, isDefault: true }, { onSuccess: () => toast.success(tw.defaultSet), onError: () => toast.error(tw.saveFailed) })}
                    >
                      <Star className="size-4" />
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t.common.actions.edit} onClick={() => setEditing(theme)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t.common.actions.delete} onClick={() => setDeleting(theme)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && <ThemeDialog key={editing === 'new' ? 'new' : editing.id} theme={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={tw.deleteThemeTitle}
        description={tw.deleteThemeDescription.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(tw.themeDeleted);
          } catch {
            toast.error(tw.deleteThemeFailed);
          } finally {
            setDeleting(null);
          }
        }}
      />
    </Section>
  );
}

function ThemeDialog({ theme, onClose }: Readonly<{ theme: FormTheme | null; onClose: () => void }>) {
  const { t } = useI18n();
  const tw = t.weldforms.workspaceSettings;
  const create = useCreateFormTheme();
  const update = useUpdateFormTheme();
  const [name, setName] = useState(theme?.name ?? '');
  const [tokens, setTokens] = useState<FormThemeTokens>(theme?.tokens ?? DEFAULT_TOKENS);
  const sample = useMemo(
    () =>
      createSampleDefinition({
        welcome: t.weldforms.design.sample.welcome,
        nameQuestion: t.weldforms.design.sample.nameQuestion,
        choiceQuestion: t.weldforms.design.sample.choiceQuestion,
        options: [t.weldforms.design.sample.optionA, t.weldforms.design.sample.optionB, t.weldforms.design.sample.optionC],
        ending: t.weldforms.design.sample.ending,
      }),
    [t],
  );

  async function save() {
    if (name.trim() === '') return;
    try {
      if (theme) await update.mutateAsync({ id: theme.id, name: name.trim(), tokens });
      else await create.mutateAsync({ name: name.trim(), tokens });
      toast.success(tw.themeSaved);
      onClose();
    } catch {
      toast.error(tw.saveFailed);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{theme ? tw.editTheme : tw.newTheme}</DialogTitle>
          <DialogDescription>{tw.themeDialogDescription}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <FormField label={tw.themeName}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder={tw.themeNamePlaceholder} autoFocus />
            </FormField>
            <ThemeTokensEditor tokens={tokens} onChange={setTokens} />
          </div>
          <div className="h-80 md:h-[28rem]">
            <FormPreview definition={sample} theme={tokens} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={name.trim() === '' || create.isPending || update.isPending}>
            {t.common.actions.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sender, reminders, badge
// ---------------------------------------------------------------------------

type GeneralDraft = Pick<FormsWorkspaceSettings, 'senderName' | 'reminderAfterDays' | 'reminderEveryDays' | 'reminderMaxCount' | 'showBadge'>;

function GeneralSection({ settings, canManage }: Readonly<{ settings: FormsWorkspaceSettings; canManage: boolean }>) {
  const { t } = useI18n();
  const tw = t.weldforms.workspaceSettings;
  const update = useUpdateFormsSettings();
  const initial: GeneralDraft = {
    senderName: settings.senderName,
    reminderAfterDays: settings.reminderAfterDays,
    reminderEveryDays: settings.reminderEveryDays,
    reminderMaxCount: settings.reminderMaxCount,
    showBadge: settings.showBadge,
  };
  const [draft, setDraft] = useState<GeneralDraft>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const patch = (change: Partial<GeneralDraft>) => setDraft((d) => ({ ...d, ...change }));

  async function save() {
    try {
      await update.mutateAsync({ ...draft, senderName: draft.senderName?.trim() ? draft.senderName.trim() : null });
      toast.success(tw.saved);
    } catch {
      toast.error(tw.saveFailed);
    }
  }

  return (
    <>
      <Section title={tw.invitations} description={tw.invitationsDescription}>
        <FormField label={tw.senderName} helpText={tw.senderNameHelp}>
          <Input value={draft.senderName ?? ''} onChange={(e) => patch({ senderName: e.target.value })} maxLength={100} disabled={!canManage} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={tw.reminderAfter} helpText={tw.reminderAfterHelp}>
            <NumberInput value={draft.reminderAfterDays ?? undefined} onValueChange={(v) => patch({ reminderAfterDays: v === undefined ? null : Math.min(30, Math.max(1, Math.floor(v))) })} min={1} max={30} disabled={!canManage} />
          </FormField>
          <FormField label={tw.reminderEvery}>
            <NumberInput value={draft.reminderEveryDays ?? undefined} onValueChange={(v) => patch({ reminderEveryDays: v === undefined ? null : Math.min(30, Math.max(1, Math.floor(v))) })} min={1} max={30} disabled={!canManage} />
          </FormField>
          <FormField label={tw.reminderMax}>
            <NumberInput value={draft.reminderMaxCount} onValueChange={(v) => patch({ reminderMaxCount: Math.min(5, Math.max(0, Math.floor(v ?? 0))) })} min={0} max={5} disabled={!canManage} />
          </FormField>
        </div>
      </Section>

      <Section title={tw.branding}>
        <ToggleRow
          id="workspace-badge"
          label={tw.showBadge}
          description={settings.canHideBadge ? tw.showBadgeHelp : tw.showBadgeLocked}
          checked={settings.canHideBadge ? draft.showBadge : true}
          disabled={!canManage || !settings.canHideBadge}
          onCheckedChange={(showBadge) => patch({ showBadge })}
        />
      </Section>

      {canManage && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => void save()} disabled={!dirty || update.isPending}>
            {t.common.actions.save}
          </Button>
        </div>
      )}
    </>
  );
}

