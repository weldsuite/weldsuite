/**
 * The Create tab: block outline on the left, the live preview in the middle
 * (desktop or phone, either layout), properties of the selection on the right.
 * Below `lg` the three panes become a switcher.
 */

import { useState } from 'react';
import { ChevronDown, ListTree, Monitor, SlidersHorizontal, Smartphone, Eye } from 'lucide-react';
import type { FormLayout } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { FormPreview, type PreviewDevice } from '../../components/form-preview';
import { topLevelIndex } from '../../lib/blocks';
import { useEffectiveTheme } from '../../lib/use-effective-theme';
import { useFormEditor, type Selection } from '../editor-context';
import { DataDialog } from './data-dialog';
import { Outline } from './outline';
import { PropertiesPanel } from './properties-panel';

type Pane = 'outline' | 'preview' | 'properties';

/** Changes with the selection, so the preview restarts at what was picked. */
function selectionKey(selection: Selection): string {
  if (!selection) return '';
  const id = 'id' in selection ? selection.id : '';
  return `${selection.kind}:${id}`;
}

export default function CreateTab() {
  const { t } = useI18n();
  const editor = useFormEditor();
  const { definition, selection } = editor;
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [layoutOverride, setLayoutOverride] = useState<FormLayout | null>(null);
  const [pane, setPane] = useState<Pane>('outline');
  const [dataOpen, setDataOpen] = useState(false);
  const { tokens } = useEffectiveTheme(editor.draft.themeId);
  const te = t.weldforms.editor;

  const layout = layoutOverride ?? definition.presentation.layout;
  const topIndex = selection?.kind === 'block' ? topLevelIndex(definition, selection.id) : -1;
  const startAt = topIndex === -1 ? undefined : definition.blocks[topIndex]?.id;

  const panes: Array<{ id: Pane; label: string; icon: typeof ListTree }> = [
    { id: 'outline', label: te.paneOutline, icon: ListTree },
    { id: 'preview', label: te.panePreview, icon: Eye },
    { id: 'properties', label: te.paneProperties, icon: SlidersHorizontal },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!editor.canEdit && <InfoBanner variant="info" className="m-3 mb-0">{te.readOnly}</InfoBanner>}

      <div role="tablist" aria-label={te.panes} className="flex border-b lg:hidden">
        {panes.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={pane === id}
            onClick={() => setPane(id)}
            className={cn('flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2 text-sm', pane === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground')}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className={cn('min-h-0 w-full shrink-0 border-r lg:block lg:w-72', pane === 'outline' ? 'block' : 'hidden')} aria-label={te.paneOutline}>
          <Outline onDataClick={() => setDataOpen(true)} />
        </aside>

        <main className={cn('min-h-0 min-w-0 flex-1 flex-col bg-muted/30 lg:flex', pane === 'preview' ? 'flex' : 'hidden')} aria-label={te.panePreview}>
          <div className="flex items-center justify-between gap-2 border-b bg-background px-3 py-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label={`${te.previewLayout}: ${layout === 'classic' ? te.classic : te.conversational}`}>
                  {layout === 'classic' ? te.classic : te.conversational}
                  <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={layout} onValueChange={(v) => setLayoutOverride(v as FormLayout)}>
                  <DropdownMenuRadioItem value="conversational">{te.conversational}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="classic">{te.classic}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ToggleGroup type="single" size="sm" variant="outline" value={device} onValueChange={(v) => v && setDevice(v as PreviewDevice)} aria-label={te.previewDevice}>
              <ToggleGroupItem value="desktop" aria-label={t.weldforms.preview.desktop}>
                <Monitor className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="phone" aria-label={t.weldforms.preview.phone}>
                <Smartphone className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="min-h-0 flex-1 p-3">
            {definition.blocks.length === 0 && !definition.welcome ? (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">{te.previewEmpty}</div>
            ) : (
              <FormPreview definition={definition} theme={tokens} layout={layout} device={device} startAtBlockId={startAt} resetKey={selectionKey(selection)} />
            )}
          </div>
        </main>

        <aside className={cn('min-h-0 w-full shrink-0 overflow-y-auto border-l lg:block lg:w-80', pane === 'properties' ? 'block' : 'hidden')} aria-label={te.paneProperties}>
          <PropertiesPanel />
        </aside>
      </div>

      <DataDialog open={dataOpen} onOpenChange={setDataOpen} />
    </div>
  );
}
