/**
 * Condition editing for the Logic tab: AND/OR groups (one level of nesting),
 * condition rows with an operand picker per side, and the operand pickers
 * themselves (fields, hidden fields, variables and constants, with choice
 * pickers for choice fields).
 */

import { Plus, Trash2 } from 'lucide-react';
import {
  fieldsOf,
  type Condition,
  type ConditionGroup,
  type ConditionOperator,
  type FieldBlock,
  type FormDefinition,
  type Operand,
  type OperandKind,
} from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import {
  conditionFor,
  conditionForField,
  defaultConstant,
  leftOperandForField,
  operandKind,
  operatorsForKind,
  reconcileCondition,
  readableFields,
  rightInputFor,
  variableTypeMap,
} from '../../lib/logic-ops';

interface Ctx {
  def: FormDefinition;
  /** Top-level index of the block the rule belongs to; null for ending rules (every field is readable). */
  sourceIndex: number | null;
  disabled: boolean;
}

type OperandSource = 'field' | 'hidden' | 'variable' | 'constant';

function operandKey(operand: Operand): string {
  switch (operand.type) {
    case 'field':
      return `field:${operand.id}`;
    case 'hidden':
      return `hidden:${operand.name}`;
    case 'variable':
      return `variable:${operand.name}`;
    case 'constant':
      return 'constant';
  }
}

/** The options the left-hand picker offers, grouped. */
function useOperandOptions(ctx: Ctx, sources: readonly OperandSource[]) {
  const { def, sourceIndex } = ctx;
  const fields = sources.includes('field') ? readableFields(def, sourceIndex) : [];
  const hidden = sources.includes('hidden') ? def.hidden.map((h) => h.name) : [];
  const variables = sources.includes('variable') ? ['score', ...def.variables.map((v) => v.name)] : [];
  return { fields, hidden, variables };
}

function fieldLabel(field: FieldBlock): string {
  return field.title.trim() === '' ? field.ref : field.title;
}

/** The choices (or matrix columns) a constant can pick from for a left operand. */
export function choicesForOperand(def: FormDefinition, operand: Operand): Array<{ id: string; label: string }> {
  if (operand.type !== 'field') return [];
  const field = fieldsOf(def).find((f) => f.id === operand.id);
  if (!field) return [];
  if (field.type === 'multiple_choice' || field.type === 'dropdown' || field.type === 'picture_choice') {
    return field.properties.choices.map((c) => ({ id: c.id, label: c.label }));
  }
  if (field.type === 'matrix') return field.properties.columns.map((c) => ({ id: c.id, label: c.label }));
  return [];
}

interface OperandPickerProps {
  ctx: Ctx;
  value: Operand;
  onChange: (operand: Operand) => void;
  sources: readonly OperandSource[];
  ariaLabel: string;
  /** For a constant: what to type, derived from the left side. */
  constantInput?: ReturnType<typeof rightInputFor>;
  /** For a constant on the right of a choice field: the left operand, to list its choices. */
  choicesOf?: Operand;
}

/** One side of a condition or a calculation value. */
export function OperandPicker({ ctx, value, onChange, sources, ariaLabel, constantInput = 'text', choicesOf }: Readonly<OperandPickerProps>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const { def } = ctx;
  const options = useOperandOptions(ctx, sources);
  const hasConstant = sources.includes('constant');

  const field = value.type === 'field' ? fieldsOf(def).find((f) => f.id === value.id) : undefined;

  function pick(key: string) {
    if (key === 'constant') {
      onChange(defaultConstant(constantInput === 'none' ? 'text' : constantInput));
      return;
    }
    const [type, ...rest] = key.split(':');
    const id = rest.join(':');
    if (type === 'field') {
      const picked = fieldsOf(def).find((f) => f.id === id);
      if (picked) onChange(leftOperandForField(picked));
    } else if (type === 'hidden') onChange({ type: 'hidden', name: id });
    else if (type === 'variable') onChange({ type: 'variable', name: id });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select value={operandKey(value)} onValueChange={pick} disabled={ctx.disabled}>
        <SelectTrigger size="sm" className="h-8 min-w-32 max-w-56" aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {hasConstant && <SelectItem value="constant">{tl.constantValue}</SelectItem>}
          {options.fields.map((f) => (
            <SelectItem key={f.id} value={`field:${f.id}`}>
              {fieldLabel(f)}
            </SelectItem>
          ))}
          {options.hidden.map((name) => (
            <SelectItem key={name} value={`hidden:${name}`}>
              {tl.hiddenPrefix} {name}
            </SelectItem>
          ))}
          {options.variables.map((name) => (
            <SelectItem key={name} value={`variable:${name}`}>
              {tl.variablePrefix} {name}
            </SelectItem>
          ))}
          {/* A value that points at something that no longer exists still shows up, so it can be seen and replaced. */}
          {value.type !== 'constant' && !isListed(value, options) && (
            <SelectItem value={operandKey(value)}>{tl.missing}</SelectItem>
          )}
        </SelectContent>
      </Select>

      {value.type === 'field' && field?.type === 'matrix' && (
        <Select value={value.rowId ?? ''} onValueChange={(rowId) => onChange({ ...value, rowId })} disabled={ctx.disabled}>
          <SelectTrigger size="sm" className="h-8 min-w-24" aria-label={tl.matrixRow}>
            <SelectValue placeholder={tl.matrixRow} />
          </SelectTrigger>
          <SelectContent>
            {field.properties.rows.map((row) => (
              <SelectItem key={row.id} value={row.id}>
                {row.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {value.type === 'field' && (field?.type === 'contact_info' || field?.type === 'address') && (
        <Select value={value.part ?? ''} onValueChange={(part) => onChange({ ...value, part })} disabled={ctx.disabled}>
          <SelectTrigger size="sm" className="h-8 min-w-24" aria-label={tl.part}>
            <SelectValue placeholder={tl.part} />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(field.properties.fields).map((part) => (
              <SelectItem key={part} value={part}>
                {(t.weldforms.properties.partNames as Record<string, string>)[part] ?? part}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.type === 'constant' && <ConstantInput ctx={ctx} value={value} onChange={onChange} input={constantInput} choicesOf={choicesOf} ariaLabel={ariaLabel} />}
    </div>
  );
}

function isListed(value: Operand, options: { fields: FieldBlock[]; hidden: string[]; variables: string[] }): boolean {
  if (value.type === 'field') return options.fields.some((f) => f.id === value.id);
  if (value.type === 'hidden') return options.hidden.includes(value.name);
  if (value.type === 'variable') return options.variables.includes(value.name);
  return true;
}

interface ConstantInputProps {
  ctx: Ctx;
  value: Extract<Operand, { type: 'constant' }>;
  onChange: (operand: Operand) => void;
  input: ReturnType<typeof rightInputFor>;
  choicesOf?: Operand;
  ariaLabel: string;
}

function ConstantInput({ ctx, value, onChange, input, choicesOf, ariaLabel }: Readonly<ConstantInputProps>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const set = (v: Extract<Operand, { type: 'constant' }>['value']) => onChange({ type: 'constant', value: v });
  const choices = choicesOf ? choicesForOperand(ctx.def, choicesOf) : [];

  switch (input) {
    case 'number':
      return (
        <Input
          type="number"
          value={typeof value.value === 'number' ? value.value : ''}
          onChange={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
          aria-label={ariaLabel}
          disabled={ctx.disabled}
          className="h-8 w-28"
        />
      );
    case 'boolean':
      return (
        <Select value={value.value === false ? 'no' : 'yes'} onValueChange={(v) => set(v === 'yes')} disabled={ctx.disabled}>
          <SelectTrigger size="sm" className="h-8 w-24" aria-label={ariaLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="yes">{tl.yes}</SelectItem>
            <SelectItem value="no">{tl.no}</SelectItem>
          </SelectContent>
        </Select>
      );
    case 'date':
      return <Input type="date" value={typeof value.value === 'string' ? value.value : ''} onChange={(e) => set(e.target.value)} aria-label={ariaLabel} disabled={ctx.disabled} className="h-8 w-40" />;
    case 'choice':
      return (
        <Select value={typeof value.value === 'string' ? value.value : ''} onValueChange={set} disabled={ctx.disabled}>
          <SelectTrigger size="sm" className="h-8 min-w-32 max-w-56" aria-label={ariaLabel}>
            <SelectValue placeholder={tl.pickChoice} />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'choices': {
      const selected = Array.isArray(value.value) ? value.value : [];
      return (
        <div className="flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label={ariaLabel}>
          {choices.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={selected.includes(c.id)} onCheckedChange={(checked) => set(checked === true ? [...selected, c.id] : selected.filter((id) => id !== c.id))} disabled={ctx.disabled} />
              {c.label}
            </label>
          ))}
        </div>
      );
    }
    case 'none':
      return null;
    default:
      return <Input value={typeof value.value === 'string' ? value.value : String(value.value)} onChange={(e) => set(e.target.value)} aria-label={ariaLabel} disabled={ctx.disabled} className="h-8 min-w-32" maxLength={1000} />;
  }
}

// ---------------------------------------------------------------------------
// Conditions and groups
// ---------------------------------------------------------------------------

interface ConditionRowProps {
  ctx: Ctx;
  condition: Condition;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}

function ConditionRow({ ctx, condition, onChange, onRemove, canRemove }: Readonly<ConditionRowProps>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const types = variableTypeMap(ctx.def);
  const leftKind: OperandKind | null = operandKind(ctx.def, condition.left, types);
  const operators: ConditionOperator[] = leftKind ? operatorsForKind(leftKind) : [];
  const input = leftKind ? rightInputFor(leftKind, condition.operator) : 'none';
  const operatorNames = tl.operators as Record<string, string>;

  function setLeft(left: Operand) {
    onChange(reconcileCondition({ ...condition, left }, operandKind(ctx.def, left, types)));
  }

  return (
    <div className="flex flex-wrap items-start gap-1.5 rounded-md border bg-card p-2">
      <OperandPicker ctx={ctx} value={condition.left} onChange={setLeft} sources={['field', 'hidden', 'variable']} ariaLabel={tl.left} />
      <Select
        value={operators.includes(condition.operator) ? condition.operator : ''}
        onValueChange={(operator) => onChange(reconcileCondition({ ...condition, operator: operator as ConditionOperator }, leftKind))}
        disabled={ctx.disabled || leftKind === null}
      >
        <SelectTrigger size="sm" className="h-8 min-w-32" aria-label={tl.operator}>
          <SelectValue placeholder={tl.operator} />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>
              {operatorNames[op] ?? op}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {input !== 'none' && condition.right && (
        <OperandPicker
          ctx={ctx}
          value={condition.right}
          onChange={(right) => onChange({ ...condition, right })}
          sources={['constant', 'field', 'hidden', 'variable']}
          ariaLabel={tl.right}
          constantInput={input}
          choicesOf={condition.left}
        />
      )}
      {!ctx.disabled && canRemove && (
        <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" onClick={onRemove} aria-label={t.common.actions.remove}>
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

function newCondition(ctx: Ctx): Condition {
  const first = readableFields(ctx.def, ctx.sourceIndex)[0];
  if (first) return conditionForField(first);
  const hidden = ctx.def.hidden[0];
  if (hidden) return conditionFor({ type: 'hidden', name: hidden.name }, 'text');
  return conditionFor({ type: 'variable', name: 'score' }, 'number');
}

interface GroupEditorProps {
  ctx: Ctx;
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
  /** Allow a nested group (the top level only: nesting is one level deep). */
  allowNested?: boolean;
}

type GroupItem = ConditionGroup['conditions'][number];

export function ConditionGroupEditor({ ctx, group, onChange, allowNested = true }: Readonly<GroupEditorProps>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;

  const setItem = (index: number, item: GroupItem) => onChange({ ...group, conditions: group.conditions.map((c, i) => (i === index ? item : c)) });
  const removeItem = (index: number) => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });

  return (
    <div className="space-y-2">
      {group.conditions.length > 1 && (
        <ToggleGroup type="single" size="sm" variant="outline" value={group.op} onValueChange={(op) => op && onChange({ ...group, op: op as 'and' | 'or' })} disabled={ctx.disabled} aria-label={tl.match}>
          <ToggleGroupItem value="and">{tl.matchAll}</ToggleGroupItem>
          <ToggleGroupItem value="or">{tl.matchAny}</ToggleGroupItem>
        </ToggleGroup>
      )}
      {group.conditions.map((item, index) =>
        'op' in item ? (
          <div key={index} className="space-y-2 rounded-md border border-dashed p-2">
            <div className="flex items-center justify-between gap-2">
              <ToggleGroup type="single" size="sm" variant="outline" value={item.op} onValueChange={(op) => op && setItem(index, { ...item, op: op as 'and' | 'or' })} disabled={ctx.disabled} aria-label={tl.match}>
                <ToggleGroupItem value="and">{tl.matchAll}</ToggleGroupItem>
                <ToggleGroupItem value="or">{tl.matchAny}</ToggleGroupItem>
              </ToggleGroup>
              {!ctx.disabled && (
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeItem(index)} aria-label={t.common.actions.remove}>
                  <Trash2 />
                </Button>
              )}
            </div>
            {item.conditions.map((condition, ci) => (
              <ConditionRow
                key={ci}
                ctx={ctx}
                condition={condition}
                canRemove={item.conditions.length > 1}
                onChange={(next) => setItem(index, { ...item, conditions: item.conditions.map((c, k) => (k === ci ? next : c)) })}
                onRemove={() => setItem(index, { ...item, conditions: item.conditions.filter((_, k) => k !== ci) })}
              />
            ))}
            {!ctx.disabled && item.conditions.length < 20 && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setItem(index, { ...item, conditions: [...item.conditions, newCondition(ctx)] })}>
                <Plus />
                {tl.addCondition}
              </Button>
            )}
          </div>
        ) : (
          <ConditionRow key={index} ctx={ctx} condition={item} canRemove={group.conditions.length > 1} onChange={(next) => setItem(index, next)} onRemove={() => removeItem(index)} />
        ),
      )}
      {!ctx.disabled && (
        <div className="flex flex-wrap gap-1">
          {group.conditions.length < 20 && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition(ctx)] })}>
              <Plus />
              {tl.addCondition}
            </Button>
          )}
          {allowNested && group.conditions.length < 20 && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onChange({ ...group, conditions: [...group.conditions, { op: group.op === 'and' ? 'or' : 'and', conditions: [newCondition(ctx)] }] })}>
              <Plus />
              {tl.addGroup}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export type { Ctx as LogicContext };
export { newCondition };
