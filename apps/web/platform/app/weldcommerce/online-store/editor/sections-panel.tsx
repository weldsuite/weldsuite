/**
 * The editor's left panel: the header group, the sections of the template or
 * content page being edited, and the footer group, each with its sections in
 * order. A section is selected to edit its settings; it can be moved up or
 * down, hidden and shown, and removed (never a main section, which every page
 * of that kind needs once). Sections that take blocks list them under the
 * selected section, with the same controls, up to the catalog's maximum.
 *
 * Reordering is by move up and move down buttons, the Modern Web Guidance
 * drag-and-drop guide's most discoverable keyboard and screen reader route:
 * focus stays on the button that was used (or moves to the other one at an
 * edge), and one polite announcement says where the item went.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Palette, Plus, Settings2, Trash2 } from 'lucide-react';
import { SECTION_CATALOG, addableSections, type Block, type Section, type SettingDefinition } from '@weldsuite/storefront-theme/catalog';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fill } from '@/app/weldcommerce/lib/text';
import {
  addBlock,
  addSection,
  addSectionRefusal,
  blockTypes,
  canAddBlock,
  canRemoveSection,
  getList,
  isRequired,
  listKeyEquals,
  maxBlocks,
  moveBlock,
  moveSection,
  removeBlock,
  removeSection,
  setList,
  toggleSectionHidden,
  type ListKey,
} from '../lib/document';
import { pickLabel } from '../lib/labels';
import { selectionAtom, useEditorContent, useEditorDispatch } from './editor-state';

function sectionName(section: Pick<Section, 'type'>): string {
  return pickLabel(SECTION_CATALOG[section.type]?.name) || section.type;
}

function blockName(section: Pick<Section, 'type'>, block: Block, index: number): string {
  const definition = SECTION_CATALOG[section.type]?.blocks[block.type];
  const name = pickLabel(definition?.name) || block.type;
  const textSetting = definition?.settings.find((setting: SettingDefinition) => setting.type === 'text' && typeof block.settings[setting.id] === 'string' && block.settings[setting.id] !== '');
  const summary = textSetting ? String(block.settings[textSetting.id]) : '';
  return summary ? `${name}: ${summary}` : `${name} ${index + 1}`;
}

function listId(key: ListKey): string {
  return key.name === 'content' ? `content-${key.pageId}` : key.name;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Changes the sections of `listKey`; an update that changes none of them is no change (and no undo step). */
function useListChange(listKey: ListKey): (update: (sections: Section[]) => Section[]) => void {
  const dispatch = useEditorDispatch();
  return (update) =>
    dispatch({
      type: 'change',
      update: (content) => {
        const before = getList(content, listKey);
        const after = update(before);
        return sameList(before, after) ? content : setList(content, listKey, after);
      },
    });
}

interface PanelActions {
  readOnly: boolean;
  announce: (message: string) => void;
  /** Focus this element (a `data-focus` value) once the change has rendered. */
  focusAfter: (target: string, fallback?: string) => void;
}

function IconAction({
  label,
  onClick,
  disabled,
  focusKey,
  children,
}: Readonly<{ label: string; onClick: () => void; disabled?: boolean; focusKey?: string; children: ReactNode }>) {
  return (
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} disabled={disabled} onClick={onClick} data-focus={focusKey}>
      {children}
    </Button>
  );
}

function BlockList({ listKey, section, actions }: Readonly<{ listKey: ListKey; section: Section; actions: PanelActions }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const change = useListChange(listKey);
  const content = useEditorContent();
  const [selection, setSelection] = useAtom(selectionAtom);
  const blocks = section.blocks ?? [];
  const max = maxBlocks(section);
  const types = blockTypes(section);
  const headingId = `blocks-${listId(listKey)}-${section.id}`;
  const prefix = `block:${listId(listKey)}:${section.id}`;

  const move = (block: Block, index: number, direction: -1 | 1) => {
    change((sections) => moveBlock(sections, section.id, block.id, direction));
    const target = `${prefix}:${block.id}:${direction === -1 ? 'up' : 'down'}`;
    actions.focusAfter(target, `${prefix}:${block.id}:${direction === -1 ? 'down' : 'up'}`);
    actions.announce(fill(t.moved, { name: blockName(section, block, index), position: index + direction + 1, count: blocks.length }));
  };

  const remove = (block: Block, index: number) => {
    change((sections) => removeBlock(sections, section.id, block.id));
    if (selection?.kind === 'section' && selection.blockId === block.id) setSelection({ kind: 'section', list: listKey, sectionId: section.id });
    actions.focusAfter(`${prefix}:add`, `select:${listId(listKey)}:${section.id}`);
    actions.announce(fill(t.removed, { name: blockName(section, block, index) }));
  };

  const add = (type: string) => {
    const result = addBlock(getList(content, listKey), section.id, type);
    if (!result) return;
    change(() => result.sections);
    setSelection({ kind: 'section', list: listKey, sectionId: section.id, blockId: result.id });
    actions.announce(fill(t.added, { name: pickLabel(SECTION_CATALOG[section.type]?.blocks[type]?.name) }));
  };

  return (
    <div className="mt-1 ml-4 space-y-1 border-l pl-2">
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span id={headingId}>{t.blocks}</span>
        <span className="tabular-nums">{fill(t.blocksCount, { count: blocks.length, max })}</span>
      </div>
      {blocks.length > 0 && (
        <ul aria-labelledby={headingId} className="space-y-0.5">
          {blocks.map((block, index) => {
            const selected = selection?.kind === 'section' && listKeyEquals(selection.list, listKey) && selection.sectionId === section.id && selection.blockId === block.id;
            const name = blockName(section, block, index);
            return (
              <li key={block.id} className={cn('flex items-center gap-0.5 rounded-md', selected && 'bg-accent')}>
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  data-focus={`select:${prefix}:${block.id}`}
                  className="min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setSelection({ kind: 'section', list: listKey, sectionId: section.id, blockId: block.id })}
                >
                  {name}
                </button>
                {!actions.readOnly && (
                  <div className="flex shrink-0">
                    <IconAction label={fill(t.moveUp, { name })} disabled={index === 0} focusKey={`${prefix}:${block.id}:up`} onClick={() => move(block, index, -1)}>
                      <ArrowUp className="size-3.5" aria-hidden="true" />
                    </IconAction>
                    <IconAction
                      label={fill(t.moveDown, { name })}
                      disabled={index === blocks.length - 1}
                      focusKey={`${prefix}:${block.id}:down`}
                      onClick={() => move(block, index, 1)}
                    >
                      <ArrowDown className="size-3.5" aria-hidden="true" />
                    </IconAction>
                    <IconAction label={fill(t.remove, { name })} onClick={() => remove(block, index)}>
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </IconAction>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!actions.readOnly && (
        <div className="flex flex-wrap gap-1">
          {types.map((type, index) => (
            <Button
              key={type}
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!canAddBlock(section, type)}
              data-focus={index === 0 ? `${prefix}:add` : undefined}
              onClick={() => add(type)}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {fill(t.addBlock, { block: pickLabel(SECTION_CATALOG[section.type]?.blocks[type]?.name).toLowerCase() })}
            </Button>
          ))}
        </div>
      )}
      {blocks.length >= max && <p className="px-1 text-xs text-muted-foreground">{fill(t.blocksFull, { max })}</p>}
    </div>
  );
}

function AddSectionMenu({ listKey, title, sections, actions }: Readonly<{ listKey: ListKey; title: string; sections: Section[]; actions: PanelActions }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const dispatch = useEditorDispatch();
  const [, setSelection] = useAtom(selectionAtom);
  const types = addableSections(listKey.name);
  if (types.length === 0) return null;
  const full = sections.length >= 40;

  const add = (type: string) => {
    const result = addSection(sections, type, listKey.name);
    if (!result) return;
    dispatch({ type: 'change', update: (content) => setList(content, listKey, result.sections) });
    setSelection({ kind: 'section', list: listKey, sectionId: result.id });
    actions.announce(fill(t.added, { name: sectionName({ type }) }));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 w-full justify-start text-primary" disabled={full} aria-label={fill(t.addSectionTo, { list: title })}>
          <Plus className="size-4" aria-hidden="true" />
          {full ? t.listFull : t.addSection}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        {types.map((type) => {
          const refusal = addSectionRefusal(sections, type, listKey.name);
          return (
            <DropdownMenuItem key={type} disabled={refusal !== null} onSelect={() => add(type)} className="flex-col items-start gap-0">
              <span>{sectionName({ type })}</span>
              {refusal === 'limit' && <span className="text-xs text-muted-foreground">{t.limitReached}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SectionRow({
  listKey,
  section,
  index,
  count,
  actions,
}: Readonly<{ listKey: ListKey; section: Section; index: number; count: number; actions: PanelActions }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const change = useListChange(listKey);
  const [selection, setSelection] = useAtom(selectionAtom);
  const name = sectionName(section);
  const required = isRequired(section, listKey.name);
  const selectedSection = selection?.kind === 'section' && listKeyEquals(selection.list, listKey) && selection.sectionId === section.id ? selection : null;
  const selected = selectedSection !== null;
  const prefix = `${listId(listKey)}:${section.id}`;
  const known = section.type in SECTION_CATALOG;

  const move = (direction: -1 | 1) => {
    change((sections) => moveSection(sections, section.id, direction));
    actions.focusAfter(`${prefix}:${direction === -1 ? 'up' : 'down'}`, `${prefix}:${direction === -1 ? 'down' : 'up'}`);
    actions.announce(fill(t.moved, { name, position: index + direction + 1, count }));
  };

  const remove = () => {
    change((sections) => removeSection(sections, section.id, listKey.name));
    if (selected) setSelection(null);
    actions.focusAfter(`add:${listId(listKey)}`);
    actions.announce(fill(t.removed, { name }));
  };

  return (
    <li className={cn('rounded-md', selected && 'bg-accent/60')}>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-current={selectedSection && !selectedSection.blockId ? 'true' : undefined}
          data-focus={`select:${prefix}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring',
            section.hidden && 'text-muted-foreground',
          )}
          onClick={() => setSelection({ kind: 'section', list: listKey, sectionId: section.id })}
        >
          {required && <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className={cn('truncate', !known && 'italic')}>{name}</span>
          {required && <span className="sr-only">({t.required})</span>}
          {section.hidden && (
            <SoftBadge tone="neutral" className="shrink-0">
              {t.hidden}
            </SoftBadge>
          )}
        </button>
        {!actions.readOnly && (
          <div className="flex shrink-0">
            <IconAction label={fill(t.moveUp, { name })} disabled={index === 0} focusKey={`${prefix}:up`} onClick={() => move(-1)}>
              <ArrowUp className="size-3.5" aria-hidden="true" />
            </IconAction>
            <IconAction label={fill(t.moveDown, { name })} disabled={index === count - 1} focusKey={`${prefix}:down`} onClick={() => move(1)}>
              <ArrowDown className="size-3.5" aria-hidden="true" />
            </IconAction>
            {!required && (
              <IconAction
                label={fill(section.hidden ? t.show : t.hide, { name })}
                focusKey={`${prefix}:visibility`}
                onClick={() => {
                  change((sections) => toggleSectionHidden(sections, section.id));
                  actions.focusAfter(`${prefix}:visibility`);
                }}
              >
                {section.hidden ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
              </IconAction>
            )}
            {canRemoveSection(section, listKey.name) && (
              <IconAction label={fill(t.remove, { name })} onClick={remove}>
                <Trash2 className="size-3.5" aria-hidden="true" />
              </IconAction>
            )}
          </div>
        )}
      </div>
      {selected && maxBlocks(section) > 0 && <BlockList listKey={listKey} section={section} actions={actions} />}
    </li>
  );
}

function SectionGroup({ title, listKey, actions }: Readonly<{ title: string; listKey: ListKey; actions: PanelActions }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const content = useEditorContent();
  const sections = getList(content, listKey);
  const headingId = `list-${listId(listKey)}`;
  return (
    <section aria-labelledby={headingId} className="space-y-1">
      <h2 id={headingId} className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {sections.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{t.emptyList}</p>
      ) : (
        <ul className="space-y-0.5">
          {sections.map((section, index) => (
            <SectionRow key={section.id} listKey={listKey} section={section} index={index} count={sections.length} actions={actions} />
          ))}
        </ul>
      )}
      {!actions.readOnly && (
        <div data-focus-group={`add:${listId(listKey)}`}>
          <AddSectionMenu listKey={listKey} title={title} sections={sections} actions={actions} />
        </div>
      )}
    </section>
  );
}

export function SectionsPanel({ listKey, title, readOnly }: Readonly<{ listKey: ListKey; title: string; readOnly: boolean }>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const [selection, setSelection] = useAtom(selectionAtom);
  const [status, setStatus] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ target: string; fallback?: string } | null>(null);
  const content = useEditorContent();

  // After a change has rendered, put focus where `focusAfter` asked (a disabled button gives way to its fallback).
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const find = (key: string | undefined) => {
      if (!key || !rootRef.current) return null;
      if (key.startsWith('add:')) return rootRef.current.querySelector<HTMLElement>(`[data-focus-group="${key}"] button`);
      return rootRef.current.querySelector<HTMLElement>(`[data-focus="${key}"]`);
    };
    const wanted = find(pending.target);
    const target = wanted && !(wanted as HTMLButtonElement).disabled ? wanted : find(pending.fallback);
    target?.focus();
  }, [content]);

  const actions: PanelActions = {
    readOnly,
    // Clear first, so the same message twice in a row is announced again.
    announce: (message) => {
      setStatus('');
      requestAnimationFrame(() => setStatus(message));
    },
    focusAfter: (target, fallback) => {
      pendingFocus.current = { target, fallback };
    },
  };

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto p-3">
        <SectionGroup title={t.groups.header} listKey={{ name: 'header' }} actions={actions} />
        <SectionGroup title={title} listKey={listKey} actions={actions} />
        <SectionGroup title={t.groups.footer} listKey={{ name: 'footer' }} actions={actions} />
      </div>
      <div className="grid gap-1 border-t p-2">
        <Button
          type="button"
          variant={selection?.kind === 'theme' ? 'secondary' : 'ghost'}
          size="sm"
          className="justify-start"
          aria-pressed={selection?.kind === 'theme'}
          onClick={() => setSelection({ kind: 'theme' })}
        >
          <Palette className="size-4" aria-hidden="true" />
          {t.themeSettings}
        </Button>
        <Button
          type="button"
          variant={selection?.kind === 'shop' ? 'secondary' : 'ghost'}
          size="sm"
          className="justify-start"
          aria-pressed={selection?.kind === 'shop'}
          onClick={() => setSelection({ kind: 'shop' })}
        >
          <Settings2 className="size-4" aria-hidden="true" />
          {t.shopSettings}
        </Button>
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
    </div>
  );
}
