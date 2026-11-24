/**
 * The editor's right panel: the settings of the selected section or block
 * (a form generated from its catalog definition), the Theme settings or the
 * Shop settings, or a hint while nothing is selected.
 */

import { useCallback, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { ChevronLeft } from 'lucide-react';
import { SECTION_CATALOG, type SettingValue } from '@weldsuite/storefront-theme/catalog';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';
import { fill } from '@/app/weldcommerce/lib/text';
import { getList, setList, updateBlockSettings, updateSectionSettings, type ListKey } from '../lib/document';
import { settingErrors } from '../lib/field-errors';
import { pickLabel } from '../lib/labels';
import { fieldErrorsAtom, selectionAtom, useEditorContent, useEditorDispatch } from './editor-state';
import { SettingsForm } from './settings-form';
import { ShopPanel, ThemePanel } from './theme-panel';

function listKeyId(key: ListKey): string {
  return key.name === 'content' ? `content:${key.pageId}` : key.name;
}

function sameSetting(a: SettingValue | undefined, b: SettingValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

function SectionInspector({
  siteId,
  readOnly,
  list,
  sectionId,
  blockId,
}: Readonly<{ siteId: string; readOnly: boolean; list: ListKey; sectionId: string; blockId?: string }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const content = useEditorContent();
  const dispatch = useEditorDispatch();
  const [, setSelection] = useAtom(selectionAtom);
  const fieldErrors = useAtomValue(fieldErrorsAtom);
  const sections = getList(content, list);
  const sectionIndex = sections.findIndex((section) => section.id === sectionId);
  const section = sections[sectionIndex];
  const definition = section ? SECTION_CATALOG[section.type] : undefined;
  const blockIndex = blockId && section ? (section.blocks ?? []).findIndex((block) => block.id === blockId) : -1;
  const block = blockIndex >= 0 ? section?.blocks?.[blockIndex] : undefined;
  const blockDefinition = block && definition ? definition.blocks[block.type] : undefined;

  const serverErrors = useMemo(
    () => settingErrors(fieldErrors, { list: list.name, sectionIndex, blockIndex: block ? blockIndex : undefined }),
    [fieldErrors, list.name, sectionIndex, block, blockIndex],
  );

  const onChange = useCallback(
    (id: string, value: SettingValue) =>
      dispatch({
        type: 'change',
        coalesceKey: `${listKeyId(list)}:${sectionId}:${blockId ?? ''}:${id}`,
        update: (current) => {
          const list_ = getList(current, list);
          const target = list_.find((s) => s.id === sectionId);
          if (!target) return current;
          if (blockId) {
            const targetBlock = target.blocks?.find((b) => b.id === blockId);
            if (!targetBlock || sameSetting(targetBlock.settings[id], value)) return current;
            return setList(current, list, updateBlockSettings(list_, sectionId, blockId, { [id]: value }));
          }
          if (sameSetting(target.settings[id], value)) return current;
          return setList(current, list, updateSectionSettings(list_, sectionId, { [id]: value }));
        },
      }),
    [dispatch, list, sectionId, blockId],
  );

  if (!section) return <p className="p-4 text-sm text-muted-foreground">{t.selectHint}</p>;
  if (!definition) return <p className="p-4 text-sm text-muted-foreground">{t.unknownSection}</p>;

  const sectionName = pickLabel(definition.name);
  const name = blockDefinition ? pickLabel(blockDefinition.name) : sectionName;
  const definitions = blockDefinition ? blockDefinition.settings : definition.settings;
  const values = block ? block.settings : section.settings;

  return (
    <div className="space-y-4 p-4">
      {block && (
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setSelection({ kind: 'section', list, sectionId })}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          {fill(t.backToSection, { name: sectionName })}
        </Button>
      )}
      <h2 className="text-base font-semibold">{name}</h2>
      {definitions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noSettings}</p>
      ) : (
        <SettingsForm
          key={`${listKeyId(list)}:${sectionId}:${blockId ?? ''}`}
          definitions={definitions}
          values={values}
          onChange={onChange}
          serverErrors={serverErrors}
          readOnly={readOnly}
          siteId={siteId}
          label={fill(t.settingsOf, { name })}
        />
      )}
    </div>
  );
}

export function InspectorPanel({ siteId, readOnly }: Readonly<{ siteId: string; readOnly: boolean }>) {
  const t = getTranslations('commerce').onlineStore;
  const selection = useAtomValue(selectionAtom);

  if (selection?.kind === 'theme' || selection?.kind === 'shop') {
    return (
      <div className="space-y-4 p-4">
        <h2 className="text-base font-semibold">{selection.kind === 'theme' ? t.theme.title : t.shop.title}</h2>
        {selection.kind === 'theme' ? <ThemePanel siteId={siteId} readOnly={readOnly} /> : <ShopPanel siteId={siteId} readOnly={readOnly} />}
      </div>
    );
  }
  if (selection?.kind === 'section') {
    return <SectionInspector siteId={siteId} readOnly={readOnly} list={selection.list} sectionId={selection.sectionId} blockId={selection.blockId} />;
  }
  return <p className="p-4 text-sm text-muted-foreground">{t.editor.selectHint}</p>;
}
