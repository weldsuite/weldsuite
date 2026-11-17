/**
 * The right panel of the Create tab: properties of the selected block, the
 * welcome screen or an ending.
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Copy, EllipsisVertical, Trash2 } from 'lucide-react';
import {
  isEndingUrl,
  isFieldBlock,
  uniqueRef,
  type Block,
  type FormDefinition,
  type FormEnding,
  type WelcomeScreen,
  type FieldBlock,
  type GroupBlock,
} from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Input } from '@weldsuite/ui/components/input';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useI18n } from '@/lib/i18n/provider';
import { MediaField } from '../../components/media-fields';
import { PropSection, ToggleRow } from '../../components/prop-controls';
import { RecallInput } from '../../components/recall-input';
import { duplicateBlock, locate, nudgeBlock, removeBlock, removeEnding, selectionAfterRemoval, topLevelIndex, updateBlock, updateEnding, withProperties } from '../../lib/blocks';
import { useFormEditor } from '../editor-context';
import { FieldProperties } from './field-properties';

const REF_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The ref of a block or ending: editable slug, unique across blocks and endings. */
function RefField({ def, id, value, onCommit, disabled, locked }: Readonly<{ def: FormDefinition; id: string; value: string; onCommit: (ref: string) => void; disabled: boolean; locked: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);

  const shown = focused ? text : value;
  const taken = uniqueRef(def, shown, id) !== shown;
  const invalid = shown !== '' && !REF_PATTERN.test(shown);
  let error: string | null = null;
  if (invalid) error = tp.refInvalid;
  else if (taken) error = tp.refTaken;

  return (
    <FormField label={tp.ref} helpText={locked ? tp.refPublishedHelp : tp.refHelp} error={error ?? undefined}>
      <Input
        value={shown}
        onFocus={() => {
          setText(value);
          setFocused(true);
        }}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (REF_PATTERN.test(next) && uniqueRef(def, next, id) === next) onCommit(next);
        }}
        onBlur={() => setFocused(false)}
        maxLength={64}
        disabled={disabled}
        aria-invalid={error !== null}
        className="font-mono text-xs"
      />
    </FormField>
  );
}

/**
 * A selection's settings: a header row with its name and ⋯ menu, level with
 * the preview's toolbar, then the settings.
 */
function PanelLayout({ title, menu, children }: Readonly<{ title: string; menu?: ReactNode; children: ReactNode }>) {
  const { t } = useI18n();
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background px-4 py-1.5">
        <h2 className="min-w-0 truncate text-sm font-medium leading-8">{title}</h2>
        {menu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={`${t.common.actions.openMenu}: ${title}`}>
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function PropertiesPanel() {
  const { t } = useI18n();
  const editor = useFormEditor();
  const { definition, selection, canEdit } = editor;
  const disabled = !canEdit;

  if (!selection) {
    return (
      <PanelLayout title={t.weldforms.editor.paneProperties}>
        <div className="p-4">
          <EmptyText>{t.weldforms.properties.nothingSelected}</EmptyText>
        </div>
      </PanelLayout>
    );
  }

  if (selection.kind === 'welcome') return <WelcomeProperties welcome={definition.welcome} disabled={disabled} />;
  if (selection.kind === 'ending') {
    const ending = definition.endings.find((e) => e.id === selection.id);
    return ending ? <EndingProperties key={ending.id} ending={ending} disabled={disabled} /> : null;
  }

  const found = findAnyBlock(definition, selection.id);
  if (!found) return null;
  return <BlockProperties key={found.id} block={found} disabled={disabled} />;
}

function findAnyBlock(def: FormDefinition, id: string): Block | undefined {
  for (const block of def.blocks) {
    if (block.id === id) return block;
    if (block.type === 'group') {
      const child = block.children.find((c) => c.id === id);
      if (child) return child;
    }
  }
  return undefined;
}

function WelcomeProperties({ welcome, disabled }: Readonly<{ welcome: WelcomeScreen | null; disabled: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const editor = useFormEditor();
  if (!welcome) return null;
  const patch = (change: Partial<WelcomeScreen>, key?: string) => editor.editDefinition((d) => (d.welcome ? { ...d, welcome: { ...d.welcome, ...change } } : d), key);
  const remove = () => {
    editor.editDefinition((d) => ({ ...d, welcome: null }));
    editor.select(null);
  };
  return (
    <PanelLayout
      title={tp.welcomeScreen}
      menu={
        disabled ? null : (
          <DropdownMenuItem variant="destructive" onSelect={remove}>
            <Trash2 className="size-4" />
            {tp.removeBlock}
          </DropdownMenuItem>
        )
      }
    >
      <PropSection>
        <FormField label={tp.title}>
          <RecallInput value={welcome.title} onChange={(title) => patch({ title }, 'welcome-title')} definition={editor.definition} sourceIndex={0} multiline rows={2} maxLength={1000} disabled={disabled} ariaLabel={tp.title} />
        </FormField>
        <FormField label={tp.description}>
          <RecallInput value={welcome.description ?? ''} onChange={(description) => patch({ description: description || undefined }, 'welcome-description')} definition={editor.definition} sourceIndex={0} multiline rows={3} maxLength={5000} disabled={disabled} ariaLabel={tp.description} />
        </FormField>
        <FormField label={tp.buttonText}>
          <Input value={welcome.buttonText ?? ''} onChange={(e) => patch({ buttonText: e.target.value || undefined }, 'welcome-button')} maxLength={60} disabled={disabled} />
        </FormField>
        <MediaField value={welcome.media} onChange={(media) => patch({ media })} disabled={disabled} showPlacement={false} />
      </PropSection>
    </PanelLayout>
  );
}

function EndingProperties({ ending, disabled }: Readonly<{ ending: FormEnding; disabled: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const editor = useFormEditor();
  const def = editor.definition;
  const locked = editor.form.status !== 'draft';
  const patch = (change: Partial<FormEnding>, key?: string) => editor.editDefinition((d) => updateEnding(d, ending.id, (e) => ({ ...e, ...change })), key);

  const canRemove = !disabled && def.endings.length > 1;
  const remove = () => {
    editor.editDefinition((d) => removeEnding(d, ending.id));
    editor.select(null);
  };

  return (
    <PanelLayout
      title={tp.ending}
      menu={
        canRemove ? (
          <DropdownMenuItem variant="destructive" onSelect={remove}>
            <Trash2 className="size-4" />
            {tp.removeBlock}
          </DropdownMenuItem>
        ) : null
      }
    >
      <PropSection>
        <FormField label={tp.title}>
          <RecallInput value={ending.title} onChange={(title) => patch({ title }, `${ending.id}-title`)} definition={def} sourceIndex={null} multiline rows={2} maxLength={1000} disabled={disabled} ariaLabel={tp.title} />
        </FormField>
        <FormField label={tp.description}>
          <RecallInput value={ending.description ?? ''} onChange={(description) => patch({ description: description || undefined }, `${ending.id}-description`)} definition={def} sourceIndex={null} multiline rows={3} maxLength={5000} disabled={disabled} ariaLabel={tp.description} />
        </FormField>
        <MediaField value={ending.media} onChange={(media) => patch({ media })} disabled={disabled} showPlacement={false} />
        <RefField def={def} id={ending.id} value={ending.ref} disabled={disabled} locked={locked} onCommit={(ref) => patch({ ref }, `${ending.id}-ref`)} />
      </PropSection>
      <PropSection title={tp.endingQuiz}>
        <ToggleRow id={`${ending.id}-score`} label={tp.showScore} checked={ending.showScore} disabled={disabled} onCheckedChange={(showScore) => patch({ showScore })} />
        <ToggleRow id={`${ending.id}-answers`} label={tp.showAnswers} checked={ending.showAnswers} disabled={disabled} onCheckedChange={(showAnswers) => patch({ showAnswers })} />
      </PropSection>
      <PropSection title={tp.endingNext}>
        <FormField label={tp.buttonText}>
          <Input value={ending.button?.text ?? ''} onChange={(e) => patch({ button: e.target.value || ending.button?.url ? { text: e.target.value, url: ending.button?.url ?? '' } : undefined }, `${ending.id}-btn-text`)} maxLength={60} disabled={disabled} />
        </FormField>
        {/* The schema refuses any other link, and with it every save of the draft: say so at the field. */}
        <FormField label={tp.buttonUrl} error={isEndingUrl(ending.button?.url ?? '') ? undefined : tp.linkScheme}>
          <Input value={ending.button?.url ?? ''} onChange={(e) => patch({ button: e.target.value || ending.button?.text ? { text: ending.button?.text ?? '', url: e.target.value } : undefined }, `${ending.id}-btn-url`)} maxLength={2000} placeholder="https://" disabled={disabled} />
        </FormField>
        <FormField label={tp.redirectUrl} helpText={tp.redirectHelp} error={isEndingUrl(ending.redirectUrl ?? '') ? undefined : tp.linkScheme}>
          <RecallInput value={ending.redirectUrl ?? ''} onChange={(redirectUrl) => patch({ redirectUrl: redirectUrl || undefined }, `${ending.id}-redirect`)} definition={def} sourceIndex={null} maxLength={2000} placeholder="https://" disabled={disabled} ariaLabel={tp.redirectUrl} />
        </FormField>
      </PropSection>
    </PanelLayout>
  );
}

function BlockProperties({ block, disabled }: Readonly<{ block: Block; disabled: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const editor = useFormEditor();
  const navigate = useNavigate();
  const def = editor.definition;
  const locked = editor.form.status !== 'draft';
  const topIndex = topLevelIndex(def, block.id);
  const edit = (patch: (b: Block) => Block, key?: string) => editor.editDefinition((d) => updateBlock(d, block.id, patch), key ? `${block.id}:${key}` : undefined);

  if (block.type === 'page_break') {
    return (
      <PanelLayout title={tp.pageBreak} menu={disabled ? null : <BlockMenuItems block={block} />}>
        <PropSection>
          <FormField label={tp.pageTitle}>
            <Input value={block.title} onChange={(e) => edit((b) => ({ ...b, title: e.target.value }), 'title')} maxLength={1000} disabled={disabled} />
          </FormField>
          <InfoBanner variant="info">{tp.pageBreakHelp}</InfoBanner>
        </PropSection>
      </PanelLayout>
    );
  }

  /** Typing a title keeps an auto-made ref in step with it until the form is published. */
  function setTitle(title: string) {
    editor.editDefinition(
      (d) =>
        updateBlock(d, block.id, (b) => {
          const next = { ...b, title };
          if (!locked && b.ref === uniqueRef(d, b.title || b.type, b.id)) next.ref = uniqueRef(d, title || b.type, b.id);
          return next as Block;
        }),
      `${block.id}:title`,
    );
  }

  const logicCount = def.logic.find((l) => l.blockId === (def.blocks[topIndex]?.id ?? block.id));
  const logicRules = (logicCount?.jumps.length ?? 0) + (logicCount?.calculations.length ?? 0) + (logicCount?.otherwise ? 1 : 0);
  const field: FieldBlock | null = isFieldBlock(block) ? block : null;
  let sectionTitle = tp.question;
  if (block.type === 'statement') sectionTitle = tp.statement;
  else if (block.type === 'group') sectionTitle = tp.group;

  return (
    <PanelLayout title={sectionTitle} menu={disabled ? null : <BlockMenuItems block={block} />}>
      <PropSection>
        <FormField label={tp.title}>
          <RecallInput value={block.title} onChange={setTitle} definition={def} sourceIndex={topIndex} multiline rows={2} maxLength={1000} disabled={disabled} ariaLabel={tp.title} />
        </FormField>
        <FormField label={tp.description}>
          <RecallInput value={block.description ?? ''} onChange={(description) => edit((b) => ({ ...b, description: description || undefined }) as Block, 'description')} definition={def} sourceIndex={topIndex} multiline rows={2} maxLength={5000} disabled={disabled} ariaLabel={tp.description} />
        </FormField>
        {field && (
          <>
            <ToggleRow id={`${block.id}-required`} label={tp.required} checked={field.required} disabled={disabled} onCheckedChange={(required) => edit((b) => ({ ...b, required }) as Block)} />
            <ToggleRow
              id={`${block.id}-sensitive`}
              label={tp.sensitive}
              description={tp.sensitiveHelp}
              checked={field.sensitive === true}
              disabled={disabled}
              onCheckedChange={(sensitive) => edit((b) => ({ ...b, sensitive: sensitive ? true : undefined }) as Block)}
            />
          </>
        )}
        {(block.type === 'statement' || block.type === 'group') && (
          <FormField label={tp.buttonText}>
            <Input value={block.properties.buttonText ?? ''} onChange={(e) => edit((b) => withProperties(b, { buttonText: e.target.value || undefined }), 'button')} maxLength={60} disabled={disabled} />
          </FormField>
        )}
        <MediaField value={block.media} onChange={(media) => edit((b) => ({ ...b, media }) as Block)} disabled={disabled} showPlacement={def.presentation.layout === 'conversational'} />
        <RefField def={def} id={block.id} value={block.ref} disabled={disabled} locked={locked} onCommit={(ref) => edit((b) => ({ ...b, ref }), 'ref')} />
      </PropSection>

      {field && <FieldProperties field={field} disabled={disabled} setProps={(patch, key) => edit((b) => withProperties(b, patch), key)} />}

      {block.type === 'group' && (
        <PropSection title={tp.groupContents}>
          <p className="text-sm text-muted-foreground">{block.children.length === 0 ? tp.groupEmpty : tp.groupHint}</p>
        </PropSection>
      )}

      {topIndex !== -1 && (
        <PropSection title={tp.logic}>
          <p className="text-sm text-muted-foreground">{logicRules === 0 ? tp.noLogic : tp.logicCount.replace('{count}', String(logicRules))}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const id = def.blocks[topIndex]?.id ?? block.id;
              editor.select({ kind: 'block', id });
              // Opens the Logic tab with this question's rules beside the flow.
              void navigate({ to: '/weldforms/$formId/logic', params: { formId: editor.form.id }, search: { block: id } });
            }}
          >
            {tp.editLogic}
          </Button>
        </PropSection>
      )}
    </PanelLayout>
  );
}

/** Removes a block and selects its neighbour, as the outline's row menu does. */
function useRemoveBlock(block: Block): () => void {
  const editor = useFormEditor();
  return () => {
    const next = selectionAfterRemoval(editor.definition, block.id);
    editor.editDefinition((d) => removeBlock(d, block.id));
    editor.select(next ? { kind: 'block', id: next } : null);
  };
}

/** The header's ⋯ menu for a block: the outline row menu's actions. */
function BlockMenuItems({ block }: Readonly<{ block: Block }>) {
  const { t } = useI18n();
  const to = t.weldforms.outline;
  const editor = useFormEditor();
  const remove = useRemoveBlock(block);
  const where = locate(editor.definition, block.id);
  const siblings = where?.parentId ? (editor.definition.blocks.find((b): b is GroupBlock => b.id === where.parentId)?.children.length ?? 0) : editor.definition.blocks.length;
  const first = !where || where.index === 0;
  const last = !where || where.index === siblings - 1;
  return (
    <>
      <DropdownMenuItem disabled={first} onSelect={() => editor.editDefinition((d) => nudgeBlock(d, block.id, -1))}>
        <ArrowUp className="size-4" />
        {to.moveUp}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={last} onSelect={() => editor.editDefinition((d) => nudgeBlock(d, block.id, 1))}>
        <ArrowDown className="size-4" />
        {to.moveDown}
      </DropdownMenuItem>
      {block.type !== 'page_break' && (
        <DropdownMenuItem onSelect={() => editor.editDefinition((d) => duplicateBlock(d, block.id))}>
          <Copy className="size-4" />
          {to.duplicate}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={remove}>
        <Trash2 className="size-4" />
        {t.common.actions.delete}
      </DropdownMenuItem>
    </>
  );
}
