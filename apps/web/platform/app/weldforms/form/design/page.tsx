/**
 * The Design tab: how the form looks (a workspace theme, customised in place or
 * saved as a new one) and how it behaves (layout, language, progress bar,
 * question numbers, back button), with a live preview.
 */

import { useMemo, useState } from 'react';
import { Check, Monitor, Paintbrush, Smartphone, Star } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { formThemeTokensSchema, type FormLanguage, type FormLayout, type FormThemeTokens } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateFormTheme, useUpdateFormTheme } from '@/hooks/queries/use-weldforms-queries';
import { FormPreview, type PreviewDevice } from '../../components/form-preview';
import { OptionSelect, PropSection, ToggleRow } from '../../components/prop-controls';
import { ThemeSwatch, ThemeTokensEditor } from '../../components/theme-tokens-editor';
import { THEME_PRESET_IDS, THEME_PRESETS } from '../../lib/theme-presets';
import { useEffectiveTheme } from '../../lib/use-effective-theme';
import { useFormEditor } from '../editor-context';

const DEFAULT_TOKENS = formThemeTokensSchema.parse({});

export default function DesignTab() {
  const { t } = useI18n();
  const td = t.weldforms.design;
  const editor = useFormEditor();
  const { definition, canEdit } = editor;
  const canManage = useCan('forms:manage');
  const themeState = useEffectiveTheme(editor.draft.themeId);
  const createTheme = useCreateFormTheme();
  const updateTheme = useUpdateFormTheme();
  const [device, setDevice] = useState<PreviewDevice>('desktop');

  // Tokens being customised (not saved yet) and, when they started from a stored theme, that theme.
  const [editing, setEditing] = useState<FormThemeTokens | null>(null);
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const baseTokens = themeState.tokens ?? DEFAULT_TOKENS;
  const tokens = editing ?? baseTokens;
  const presentation = definition.presentation;
  const patchPresentation = (patch: Partial<typeof presentation>) => editor.editDefinition((d) => ({ ...d, presentation: { ...d.presentation, ...patch } }));

  const selectedId = editor.draft.themeId ?? (themeState.theme?.id ?? null);
  const selectedIsDefaultFallback = editor.draft.themeId === null;

  const presetNames = td.presets as Record<string, string>;

  const customise = (from: FormThemeTokens, themeId: string | null) => {
    setEditing(from);
    setEditingThemeId(themeId);
  };

  async function saveToTheme() {
    if (!editing || !editingThemeId) return;
    try {
      await updateTheme.mutateAsync({ id: editingThemeId, tokens: editing });
      toast.success(td.themeSaved);
      setEditing(null);
      setEditingThemeId(null);
    } catch {
      toast.error(td.themeSaveFailed);
    }
  }

  async function saveAsNew() {
    if (!editing || name.trim() === '') return;
    try {
      const created = await createTheme.mutateAsync({ name: name.trim(), tokens: editing });
      editor.editDraft((d) => ({ ...d, themeId: created.data.id }));
      toast.success(td.themeCreated);
      setEditing(null);
      setEditingThemeId(null);
      setNaming(false);
      setName('');
    } catch {
      toast.error(td.themeSaveFailed);
    }
  }

  async function makeDefault(id: string) {
    try {
      await updateTheme.mutateAsync({ id, isDefault: true });
      toast.success(td.defaultSet);
    } catch {
      toast.error(td.themeSaveFailed);
    }
  }

  const themeName = useMemo(() => themeState.themes.find((x) => x.id === editingThemeId)?.name, [themeState.themes, editingThemeId]);

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="min-h-0 w-full shrink-0 overflow-y-auto border-b lg:w-96 lg:border-b-0 lg:border-r">
        {!canEdit && <InfoBanner variant="info" className="m-3">{t.weldforms.editor.readOnly}</InfoBanner>}

        <PropSection title={td.theme}>
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => {
                  editor.editDraft((d) => ({ ...d, themeId: null }));
                  setEditing(null);
                }}
                className={cn('flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm', selectedIsDefaultFallback ? 'border-primary/50 bg-primary/5' : 'hover:bg-accent/60')}
              >
                <ThemeSwatch tokens={themeState.themes.find((x) => x.id === themeState.defaultThemeId)?.tokens ?? DEFAULT_TOKENS} />
                <span className="flex-1 truncate">{td.useDefault}</span>
                {selectedIsDefaultFallback && <Check className="size-4 text-primary" aria-hidden />}
              </button>
            </li>
            {themeState.themes.map((theme) => (
              <li key={theme.id} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => {
                    editor.editDraft((d) => ({ ...d, themeId: theme.id }));
                    setEditing(null);
                  }}
                  className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm', !selectedIsDefaultFallback && selectedId === theme.id ? 'border-primary/50 bg-primary/5' : 'hover:bg-accent/60')}
                >
                  <ThemeSwatch tokens={theme.tokens} />
                  <span className="min-w-0 flex-1 truncate">{theme.name}</span>
                  {theme.id === themeState.defaultThemeId && <span className="shrink-0 text-xs text-muted-foreground">{td.defaultBadge}</span>}
                  {!selectedIsDefaultFallback && selectedId === theme.id && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
                </button>
                {canManage && theme.id !== themeState.defaultThemeId && (
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => void makeDefault(theme.id)} aria-label={td.makeDefault} title={td.makeDefault}>
                    <Star />
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {canEdit && (
            <>
              <div>
                <div className="pb-1 text-xs font-medium text-muted-foreground">{td.startFrom}</div>
                <div className="flex flex-wrap gap-1.5">
                  {THEME_PRESET_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => customise(THEME_PRESETS[id], null)}
                      className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent/60"
                    >
                      <ThemeSwatch tokens={THEME_PRESETS[id]} className="inline-flex h-4 w-9 overflow-hidden rounded border" />
                      {presetNames[id]}
                    </button>
                  ))}
                </div>
              </div>
              {!editing && (
                <Button type="button" variant="outline" size="sm" onClick={() => customise(baseTokens, editor.draft.themeId ?? themeState.theme?.id ?? null)}>
                  <Paintbrush className="size-4" />
                  {td.customise}
                </Button>
              )}
            </>
          )}
        </PropSection>

        {editing && (
          <PropSection title={td.customiseTitle}>
            <ThemeTokensEditor tokens={editing} onChange={setEditing} disabled={!canEdit} />
            <div className="flex flex-wrap gap-2 pt-1">
              {editingThemeId && (
                <Button type="button" size="sm" onClick={() => void saveToTheme()} disabled={!canManage || updateTheme.isPending}>
                  {themeName ? td.saveToTheme.replace('{name}', themeName) : td.saveToThemeShort}
                </Button>
              )}
              <Button type="button" size="sm" variant={editingThemeId ? 'outline' : 'default'} onClick={() => setNaming(true)} disabled={!canManage}>
                {td.saveAsNew}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(null); setEditingThemeId(null); }}>
                {t.common.actions.cancel}
              </Button>
            </div>
            {!canManage && <p className="text-xs text-muted-foreground">{td.needManage}</p>}
            {editingThemeId && <p className="text-xs text-muted-foreground">{td.sharedWarning}</p>}
          </PropSection>
        )}

        <PropSection title={td.presentation}>
          <OptionSelect
            label={td.layout}
            value={presentation.layout}
            disabled={!canEdit}
            options={[
              { value: 'conversational', label: t.weldforms.editor.conversational },
              { value: 'classic', label: t.weldforms.editor.classic },
            ]}
            helpText={presentation.layout === 'conversational' ? td.layoutConversationalHelp : td.layoutClassicHelp}
            onChange={(layout: FormLayout) => patchPresentation({ layout })}
          />
          <OptionSelect
            label={td.language}
            value={presentation.language}
            disabled={!canEdit}
            options={[
              { value: 'en', label: 'English' },
              { value: 'nl', label: 'Nederlands' },
            ]}
            helpText={td.languageHelp}
            onChange={(language: FormLanguage) => patchPresentation({ language })}
          />
          <OptionSelect
            label={td.progressBar}
            value={presentation.progressBar}
            disabled={!canEdit}
            options={[
              { value: 'percentage', label: td.progress.percentage },
              { value: 'proportion', label: td.progress.proportion },
              { value: 'none', label: td.progress.none },
            ]}
            onChange={(progressBar) => patchPresentation({ progressBar })}
          />
          <ToggleRow id="design-numbers" label={td.questionNumbers} checked={presentation.showQuestionNumbers} disabled={!canEdit} onCheckedChange={(showQuestionNumbers) => patchPresentation({ showQuestionNumbers })} />
          <ToggleRow id="design-back" label={td.allowBack} description={td.allowBackHelp} checked={presentation.allowBack} disabled={!canEdit} onCheckedChange={(allowBack) => patchPresentation({ allowBack })} />
        </PropSection>
      </div>

      <div className="flex min-h-[28rem] min-w-0 flex-1 flex-col bg-muted/30">
        <div className="flex items-center justify-end border-b bg-background px-3 py-1.5">
          <ToggleGroup type="single" size="sm" variant="outline" value={device} onValueChange={(v) => v && setDevice(v as PreviewDevice)} aria-label={t.weldforms.editor.previewDevice}>
            <ToggleGroupItem value="desktop" aria-label={t.weldforms.preview.desktop}>
              <Monitor className="size-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="phone" aria-label={t.weldforms.preview.phone}>
              <Smartphone className="size-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <FormPreview definition={definition} theme={tokens} device={device} />
        </div>
      </div>

      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{td.saveAsNew}</DialogTitle>
            <DialogDescription>{td.saveAsNewDescription}</DialogDescription>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder={td.themeNamePlaceholder} aria-label={td.themeName} autoFocus />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setNaming(false)}>
              {t.common.actions.cancel}
            </Button>
            <Button type="button" onClick={() => void saveAsNew()} disabled={name.trim() === '' || createTheme.isPending}>
              {t.common.actions.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
