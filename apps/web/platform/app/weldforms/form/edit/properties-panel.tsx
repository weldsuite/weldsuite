/**
 * The right panel of the Create tab: properties of the selected block, the
 * welcome screen or an ending.
 */

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  isFieldBlock,
  uniqueRef,
  type Block,
  type FormDefinition,
  type FormEnding,
  type WelcomeScreen,
  type FieldBlock,
} from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Input } from '@weldsuite/ui/components/input';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { MediaField } from '../../components/media-fields';
import { PropSection, ToggleRow } from '../../components/prop-controls';
import { RecallInput } from '../../components/recall-input';
import { removeBlock, removeEnding, topLevelIndex, updateBlock, updateEnding, withProperties } from '../../lib/blocks';
import { selectionAfterRemoval } from '../../lib/blocks';
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

export function PropertiesPanel() {
  const { t } = useI18n();
  const editor = useFormEditor();
  const { definition, selection, canEdit } = editor;
  const disabled = !canEdit;

  if (!selection) return <div className="p-4"><EmptyText>{t.weldforms.properties.nothingSelected}</EmptyText></div>;

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
  return (
    <div>
      <PropSection title={tp.welcomeScreen}>
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
      {!disabled && (
        <PropSection>
          <Button type="button" variant="outline" size="sm" onClick={() => { editor.editDefinition((d) => ({ ...d, welcome: null })); editor.select(null); }}>
            <Trash2 className="size-4" />
            {tp.removeWelcome}
          </Button>
        </PropSection>
      )}
    </div>
  );
}

function EndingProperties({ ending, disabled }: Readonly<{ ending: FormEnding; disabled: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const editor = useFormEditor();
  const def = editor.definition;
  const locked = editor.form.status !== 'draft';
  const patch = (change: Partial<FormEnding>, key?: string) => editor.editDefinition((d) => updateEnding(d, ending.id, (e) => ({ ...e, ...change })), key);

  return (
    <div>
      <PropSection title={tp.ending}>
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
        <FormField label={tp.buttonUrl}>
          <Input value={ending.button?.url ?? ''} onChange={(e) => patch({ button: e.target.value || ending.button?.text ? { text: ending.button?.text ?? '', url: e.target.value } : undefined }, `${ending.id}-btn-url`)} maxLength={2000} placeholder="https://" disabled={disabled} />
        </FormField>
        <FormField label={tp.redirectUrl} helpText={tp.redirectHelp}>
          <RecallInput value={ending.redirectUrl ?? ''} onChange={(redirectUrl) => patch({ redirectUrl: redirectUrl || undefined }, `${ending.id}-redirect`)} definition={def} sourceIndex={null} maxLength={2000} placeholder="https://" disabled={disabled} ariaLabel={tp.redirectUrl} />
        </FormField>
      </PropSection>
      {!disabled && def.endings.length > 1 && (
        <PropSection>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              editor.editDefinition((d) => removeEnding(d, ending.id));
              editor.select(null);
            }}
          >
            <Trash2 className="size-4" />
            {tp.removeEnding}
          </Button>
        </PropSection>
      )}
    </div>
  );
}

function BlockProperties({ block, disabled }: Readonly<{ block: Block; disabled: boolean }>) {
  const { t } = useI18n();
  const tp = t.weldforms.properties;
  const editor = useFormEditor();
  const def = editor.definition;
  const locked = editor.form.status !== 'draft';
  const topIndex = topLevelIndex(def, block.id);
  const edit = (patch: (b: Block) => Block, key?: string) => editor.editDefinition((d) => updateBlock(d, block.id, patch), key ? `${block.id}:${key}` : undefined);

  if (block.type === 'page_break') {
    return (
      <PropSection title={tp.pageBreak}>
        <FormField label={tp.pageTitle}>
          <Input value={block.title} onChange={(e) => edit((b) => ({ ...b, title: e.target.value }), 'title')} maxLength={1000} disabled={disabled} />
        </FormField>
        <InfoBanner variant="info">{tp.pageBreakHelp}</InfoBanner>
        <RemoveBlock block={block} disabled={disabled} />
      </PropSection>
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
    <div>
      <PropSection title={sectionTitle}>
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
          <Button asChild variant="outline" size="sm">
            <Link href={`/weldforms/${editor.form.id}/logic`} onClick={() => editor.select({ kind: 'block', id: def.blocks[topIndex]?.id ?? block.id })}>
              {tp.editLogic}
            </Link>
          </Button>
        </PropSection>
      )}

      <PropSection>
        <RemoveBlock block={block} disabled={disabled} />
      </PropSection>
    </div>
  );
}

function RemoveBlock({ block, disabled }: Readonly<{ block: Block; disabled: boolean }>) {
  const { t } = useI18n();
  const editor = useFormEditor();
  if (disabled) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        const next = selectionAfterRemoval(editor.definition, block.id);
        editor.editDefinition((d) => removeBlock(d, block.id));
        editor.select(next ? { kind: 'block', id: next } : null);
      }}
    >
      <Trash2 className="size-4" />
      {t.weldforms.properties.removeBlock}
    </Button>
  );
}
