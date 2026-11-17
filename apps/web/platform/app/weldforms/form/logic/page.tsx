/**
 * The Logic tab: the whole flow on the WeldConnect canvas, and the rules of
 * the card you click in a panel beside it (calculations, jumps and otherwise for a block;
 * the ending rules for an ending). Below lg the panel takes the tab's place,
 * with a close button back to the flow. The open card is kept in the URL
 * (`?block=`), so "Edit logic" on the Create tab can open it.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { fieldsOf, type Block, type Calculation, type ConditionGroup, type FormDefinition, type LogicTarget } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  addCalculation,
  addEndingRule,
  addJump,
  logicOf,
  moveEndingRule,
  moveJump,
  removeCalculation,
  removeEndingRule,
  removeJump,
  setOtherwise,
  targetFromKey,
  targetKey,
  targetOptions,
  updateCalculation,
  updateEndingRule,
  updateJump,
} from '../../lib/logic-edit';
import { defaultConstant, readableFields, variableTypeMap } from '../../lib/logic-ops';
import { useFormEditor } from '../editor-context';
import { ConditionGroupEditor, OperandPicker, newCondition, type LogicContext } from './condition-editor';
import { FlowDiagram } from './flow-diagram';
import { ENDINGS } from './search';

export default function LogicTab() {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const editor = useFormEditor();
  const { definition: def } = editor;
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();

  const logicBlocks = def.blocks.filter((b) => b.type !== 'page_break');
  const isEndings = search.block === ENDINGS;
  const block = isEndings ? undefined : logicBlocks.find((b) => b.id === search.block);
  const open = isEndings || block !== undefined;

  const openRules = (id: string | null) =>
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>): Record<string, unknown> => {
        const next = { ...prev };
        delete next.block;
        if (id) next.block = id;
        return next;
      },
    });

  if (logicBlocks.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title={tl.emptyTitle} description={tl.emptyDescription} />
      </div>
    );
  }

  const ctx: LogicContext = { def, sourceIndex: block ? def.blocks.indexOf(block) : null, disabled: !editor.canEdit };

  return (
    <div className="flex h-full min-h-0">
      <div className={cn('relative min-h-0 min-w-0 flex-1', open && 'hidden lg:block')}>
        <FlowDiagram
          definition={def}
          selectedId={block?.id ?? null}
          onSelect={(id, kind) => openRules(kind === 'block' ? id : ENDINGS)}
          notice={editor.canEdit ? undefined : <InfoBanner variant="info">{t.weldforms.editor.readOnly}</InfoBanner>}
        />
      </div>

      {open && (
        <aside className="min-h-0 w-full shrink-0 overflow-y-auto border-l lg:w-96" aria-label={tl.rules}>
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background px-4 py-1.5">
            <h2 className="min-w-0 truncate text-sm font-semibold">{block ? block.title || t.weldforms.outline.untitled : tl.endingRules}</h2>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => openRules(null)} aria-label={t.common.actions.close}>
              <X />
            </Button>
          </div>
          <div className="space-y-4 p-4">
            <p className="text-sm text-muted-foreground">{block ? tl.blockHelp : tl.endingRulesHelp}</p>
            {block ? <BlockLogicEditor key={block.id} ctx={ctx} block={block} /> : <EndingRulesEditor ctx={ctx} />}
          </div>
        </aside>
      )}
    </div>
  );
}

function TargetSelect({ ctx, value, onChange, allowNext, ariaLabel }: Readonly<{ ctx: LogicContext; value: LogicTarget | null; onChange: (target: LogicTarget | null) => void; allowNext?: boolean; ariaLabel: string }>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const options = ctx.sourceIndex === null ? ctx.def.endings.map((e) => ({ target: { type: 'ending', id: e.id } as LogicTarget, label: e.title || e.ref })) : targetOptions(ctx.def, ctx.sourceIndex);
  const known = options.some((o) => targetKey(o.target) === targetKey(value));
  return (
    <Select value={targetKey(value)} onValueChange={(key) => onChange(targetFromKey(key))} disabled={ctx.disabled}>
      <SelectTrigger size="sm" className="h-8 min-w-40 max-w-72" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowNext && <SelectItem value="next">{tl.nextBlock}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={targetKey(o.target)} value={targetKey(o.target)}>
            {o.target.type === 'ending' ? `${tl.endingPrefix} ${o.label}` : o.label}
          </SelectItem>
        ))}
        {value && !known && <SelectItem value={targetKey(value)}>{tl.missing}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

function Card({ title, children, actions }: Readonly<{ title: string; children: React.ReactNode; actions?: React.ReactNode }>) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function BlockLogicEditor({ ctx, block }: Readonly<{ ctx: LogicContext; block: Block }>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const editor = useFormEditor();
  const def = ctx.def;
  const logic = logicOf(def, block.id);
  const edit = (recipe: (d: FormDefinition) => FormDefinition) => editor.editDefinition(recipe);
  const sourceIndex = ctx.sourceIndex ?? 0;
  const hasTargets = targetOptions(def, sourceIndex).length > 0;
  const types = variableTypeMap(def);

  function newJump() {
    const targets = targetOptions(def, sourceIndex);
    const first = targets[0];
    if (!first) return;
    edit((d) => addJump(d, block.id, { op: 'and', conditions: [newCondition(ctx)] }, first.target));
  }

  function newCalculation() {
    const variable = ['score', ...def.variables.map((v) => v.name)][0] ?? 'score';
    edit((d) => addCalculation(d, block.id, { when: null, variable, op: 'add', value: { type: 'constant', value: 1 } }));
  }

  const hasFields = readableFields(def, sourceIndex).length > 0 || def.hidden.length > 0;

  return (
    <>
      <Card
        title={tl.calculations}
        actions={
          !ctx.disabled && (
            <Button type="button" variant="outline" size="sm" onClick={newCalculation}>
              <Plus className="size-4" />
              {tl.addCalculation}
            </Button>
          )
        }
      >
        {logic.calculations.length === 0 && <p className="text-sm text-muted-foreground">{tl.noCalculations}</p>}
        {logic.calculations.map((calc) => (
          <CalculationRow
            key={calc.id}
            ctx={ctx}
            calc={calc}
            isTextVariable={types.get(calc.variable) === 'text'}
            onChange={(next) => edit((d) => updateCalculation(d, block.id, calc.id, () => next))}
            onRemove={() => edit((d) => removeCalculation(d, block.id, calc.id))}
          />
        ))}
      </Card>

      <Card
        title={tl.jumps}
        actions={
          !ctx.disabled && (
            <Button type="button" variant="outline" size="sm" onClick={newJump} disabled={!hasTargets || !hasFields}>
              <Plus className="size-4" />
              {tl.addJump}
            </Button>
          )
        }
      >
        {logic.jumps.length === 0 && <p className="text-sm text-muted-foreground">{tl.noJumps}</p>}
        {logic.jumps.map((jump, index) => (
          <div key={jump.id} className="space-y-2 rounded-md border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tl.ifLabel}</span>
              {!ctx.disabled && (
                <div className="flex gap-0.5">
                  <Button type="button" variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => edit((d) => moveJump(d, block.id, jump.id, -1))} aria-label={tl.moveUp}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" disabled={index === logic.jumps.length - 1} onClick={() => edit((d) => moveJump(d, block.id, jump.id, 1))} aria-label={tl.moveDown}>
                    <ArrowDown />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => edit((d) => removeJump(d, block.id, jump.id))} aria-label={t.common.actions.remove}>
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
            <ConditionGroupEditor ctx={ctx} group={jump.when} onChange={(when: ConditionGroup) => edit((d) => updateJump(d, block.id, jump.id, (j) => ({ ...j, when })))} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{tl.thenGoTo}</span>
              <TargetSelect ctx={ctx} value={jump.to} ariaLabel={tl.goTo} onChange={(to) => to && edit((d) => updateJump(d, block.id, jump.id, (j) => ({ ...j, to })))} />
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-sm">{tl.otherwise}</span>
          <TargetSelect ctx={ctx} value={logic.otherwise} allowNext ariaLabel={tl.otherwise} onChange={(to) => edit((d) => setOtherwise(d, block.id, to))} />
        </div>
      </Card>
    </>
  );
}

function CalculationRow({ ctx, calc, isTextVariable, onChange, onRemove }: Readonly<{ ctx: LogicContext; calc: Calculation; isTextVariable: boolean; onChange: (calc: Calculation) => void; onRemove: () => void }>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const variables = ['score', ...ctx.def.variables.map((v) => v.name)];
  const ops = (isTextVariable ? ['set', 'add'] : ['add', 'subtract', 'multiply', 'divide', 'set']) as Calculation['op'][];
  const opNames = tl.calcOps as Record<string, string>;
  const conditional = calc.when !== null;
  let joiner = tl.calcBy;
  if (calc.op === 'set' || calc.op === 'add') joiner = tl.calcTo;
  else if (calc.op === 'subtract') joiner = tl.calcFrom;

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={calc.op}
          onValueChange={(op) => onChange({ ...calc, op: op as Calculation['op'] })}
          disabled={ctx.disabled}
        >
          <SelectTrigger size="sm" className="h-8 w-32" aria-label={tl.calcOperation}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((op) => (
              <SelectItem key={op} value={op}>
                {opNames[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <OperandPicker
          ctx={ctx}
          value={calc.value}
          onChange={(value) => onChange({ ...calc, value })}
          sources={['constant', 'field', 'hidden', 'variable']}
          ariaLabel={tl.calcValue}
          constantInput={isTextVariable ? 'text' : 'number'}
        />
        <span className="text-sm text-muted-foreground">{joiner}</span>
        <Select
          value={calc.variable}
          onValueChange={(variable) => {
            const nextText = ctx.def.variables.find((v) => v.name === variable)?.type === 'text';
            const nextInput = nextText ? 'text' : 'number';
            onChange({ ...calc, variable, op: nextText && calc.op !== 'set' && calc.op !== 'add' ? 'set' : calc.op, value: nextText !== isTextVariable ? defaultConstant(nextInput) : calc.value });
          }}
          disabled={ctx.disabled}
        >
          <SelectTrigger size="sm" className="h-8 min-w-28" aria-label={tl.calcVariable}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {variables.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
            {!variables.includes(calc.variable) && <SelectItem value={calc.variable}>{tl.missing}</SelectItem>}
          </SelectContent>
        </Select>
        {!ctx.disabled && (
          <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" onClick={onRemove} aria-label={t.common.actions.remove}>
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {conditional ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tl.onlyIf}</span>
              {!ctx.disabled && (
                <Button type="button" variant="ghost" size="xs" onClick={() => onChange({ ...calc, when: null })}>
                  {tl.always}
                </Button>
              )}
            </div>
            <ConditionGroupEditor ctx={ctx} group={calc.when as ConditionGroup} onChange={(when) => onChange({ ...calc, when })} />
          </>
        ) : (
          !ctx.disabled && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange({ ...calc, when: { op: 'and', conditions: [newCondition(ctx)] } })}>
              <Plus />
              {tl.makeConditional}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

function EndingRulesEditor({ ctx }: Readonly<{ ctx: LogicContext }>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const editor = useFormEditor();
  const def = ctx.def;
  const edit = (recipe: (d: FormDefinition) => FormDefinition) => editor.editDefinition(recipe);
  const hasFields = fieldsOf(def).length > 0 || def.variables.length > 0 || def.endings.length > 0;

  return (
    <>
      <Card
        title={tl.endingRules}
        actions={
          !ctx.disabled && (
            <Button type="button" variant="outline" size="sm" disabled={!hasFields || def.endings.length < 2} onClick={() => edit((d) => addEndingRule(d, { op: 'and', conditions: [newCondition(ctx)] }, d.endings[1]?.id ?? d.endings[0]?.id ?? ''))}>
              <Plus className="size-4" />
              {tl.addEndingRule}
            </Button>
          )
        }
      >
        {def.endings.length < 2 && <p className="text-sm text-muted-foreground">{tl.needTwoEndings}</p>}
        {def.endingRules.length === 0 && def.endings.length >= 2 && <p className="text-sm text-muted-foreground">{tl.noEndingRules}</p>}
        {def.endingRules.map((rule, index) => (
          <div key={rule.id} className="space-y-2 rounded-md border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tl.ifLabel}</span>
              {!ctx.disabled && (
                <div className="flex gap-0.5">
                  <Button type="button" variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => edit((d) => moveEndingRule(d, rule.id, -1))} aria-label={tl.moveUp}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" disabled={index === def.endingRules.length - 1} onClick={() => edit((d) => moveEndingRule(d, rule.id, 1))} aria-label={tl.moveDown}>
                    <ArrowDown />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" onClick={() => edit((d) => removeEndingRule(d, rule.id))} aria-label={t.common.actions.remove}>
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
            <ConditionGroupEditor ctx={ctx} group={rule.when} onChange={(when) => edit((d) => updateEndingRule(d, rule.id, (r) => ({ ...r, when })))} />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{tl.showEnding}</span>
              <TargetSelect
                ctx={ctx}
                value={{ type: 'ending', id: rule.endingId }}
                ariaLabel={tl.showEnding}
                onChange={(to) => to && to.type === 'ending' && edit((d) => updateEndingRule(d, rule.id, (r) => ({ ...r, endingId: to.id })))}
              />
            </div>
          </div>
        ))}
        {def.endings[0] && (
          <p className="border-t pt-3 text-sm text-muted-foreground">
            {tl.defaultEnding} <span className="font-medium text-foreground">{def.endings[0].title || def.endings[0].ref}</span>
          </p>
        )}
      </Card>
    </>
  );
}
