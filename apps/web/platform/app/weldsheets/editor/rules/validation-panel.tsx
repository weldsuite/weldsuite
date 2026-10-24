import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { delocalizeFormula, localizeFormula, type DataValidation, type ValidationCriteria } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from '../model/sheet-controller';
import { newRuleId, removeValidation, saveValidation } from '../model/rules';
import { fromDraft, parseRanges, rangesText, toDraft, type ConditionDraft } from './conditions';
import { ConditionFields, Field } from './fields';
import { conditionSummary, RulePanel, selectionText } from './panel';

type CriteriaType = ValidationCriteria['type'];
const CRITERIA: CriteriaType[] = ['list', 'listRange', 'checkbox', 'condition'];

/** The data validation side panel: the sheet's rules, and an editor for one. */
export function ValidationPanel({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const tv = t.weldsheets.validation;
  const [editing, setEditing] = useState<DataValidation | null>(null);
  const rules = controller.sheet.validations;
  const close = () => controller.openPanel(null);

  if (editing) {
    return (
      <RulePanel title={tv.title} closeLabel={tv.close} onClose={close}>
        <ValidationEditor controller={controller} rule={editing} onDone={() => setEditing(null)} />
      </RulePanel>
    );
  }

  const add = () =>
    setEditing({
      id: newRuleId(),
      ranges: parseRanges(selectionText(controller)) ?? [],
      criteria: { type: 'list', values: [] },
      strict: false,
      dropdown: true,
    });

  const summary = (rule: DataValidation) => {
    const c = rule.criteria;
    if (c.type === 'condition') return conditionSummary(c.condition, t.weldsheets.conditions);
    if (c.type === 'list') return `${tv.list}: ${c.values.slice(0, 4).join(', ')}${c.values.length > 4 ? ', …' : ''}`;
    if (c.type === 'listRange') return `${tv.listRange}: ${c.source}`;
    return tv.checkbox;
  };

  return (
    <RulePanel title={tv.title} closeLabel={tv.close} onClose={close}>
      {rules.length === 0 && <p className="text-sm text-muted-foreground">{tv.empty}</p>}
      <ul className="flex flex-col gap-2">
        {rules.map((rule) => (
          <li key={rule.id} className="group flex items-center gap-2 rounded-md border p-2 hover:bg-accent/50">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(rule)}>
              <span className="block truncate text-sm">{summary(rule)}</span>
              <span className="block truncate text-xs text-muted-foreground">{rangesText(rule.ranges)}</span>
            </button>
            <button
              type="button"
              className="rounded p-1 opacity-0 hover:bg-accent group-hover:opacity-100 [&_svg]:size-3.5"
              aria-label={tv.remove}
              title={tv.remove}
              onClick={() => removeValidation(controller, rule.id)}
            >
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="self-start" onClick={add}>
        <Plus />
        {tv.addRule}
      </Button>
    </RulePanel>
  );
}

function ValidationEditor({ controller, rule, onDone }: { controller: SheetController; rule: DataValidation; onDone: () => void }) {
  const { t } = useI18n();
  const tv = t.weldsheets.validation;
  const locale = controller.options.formulaLocale;
  const existing = controller.sheet.validations.some((r) => r.id === rule.id);
  const c = rule.criteria;
  const [ranges, setRanges] = useState(rangesText(rule.ranges));
  const [type, setType] = useState<CriteriaType>(c.type);
  const [items, setItems] = useState(c.type === 'list' ? c.values.join('\n') : '');
  const [source, setSource] = useState(c.type === 'listRange' ? localizeFormula(c.source, locale) : '');
  const [draft, setDraft] = useState<ConditionDraft>(() => toDraft(c.type === 'condition' ? c.condition : { type: 'greater', value: 0 }, locale));
  const [dropdown, setDropdown] = useState(rule.dropdown !== false);
  const [strict, setStrict] = useState(rule.strict);
  const [help, setHelp] = useState(rule.help ?? '');

  /** The criteria the form describes, or the message saying what is missing. */
  const criteria = (): ValidationCriteria | string => {
    switch (type) {
      case 'checkbox':
        return { type: 'checkbox' };
      case 'list': {
        const values = items
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean);
        return values.length ? { type: 'list', values } : tv.itemsRequired;
      }
      case 'listRange': {
        const text = source.trim().replace(/^=/, '');
        return text ? { type: 'listRange', source: delocalizeFormula(text, locale) } : tv.sourceRequired;
      }
      case 'condition': {
        const condition = fromDraft(draft, locale);
        return condition ? { type: 'condition', condition } : t.weldsheets.filterMenu.invalid;
      }
    }
  };

  const save = () => {
    const parsed = parseRanges(ranges);
    if (!parsed) {
      toast.error(t.weldsheets.conditionalFormats.rangeInvalid);
      return;
    }
    const result = criteria();
    if (typeof result === 'string') {
      toast.error(result);
      return;
    }
    const isList = result.type === 'list' || result.type === 'listRange';
    saveValidation(controller, {
      id: rule.id,
      ranges: parsed,
      criteria: result,
      strict,
      ...(isList && { dropdown }),
      ...(help.trim() && { help: help.trim() }),
    });
    onDone();
  };

  return (
    <div className="flex flex-col gap-4">
      <Field label={tv.applyTo}>
        <Input className="h-8 font-mono text-sm" value={ranges} onChange={(e) => setRanges(e.target.value)} aria-label={tv.applyTo} />
      </Field>
      <Field label={tv.criteria}>
        <Select value={type} onValueChange={(v) => setType(v as CriteriaType)}>
          <SelectTrigger className="h-8 w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CRITERIA.map((k) => (
              <SelectItem key={k} value={k}>
                {tv[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {type === 'list' && <Textarea rows={5} className="text-sm" placeholder={tv.items} aria-label={tv.items} value={items} onChange={(e) => setItems(e.target.value)} />}
        {type === 'listRange' && (
          <Input className="h-8 font-mono text-sm" placeholder={tv.source} aria-label={tv.source} value={source} onChange={(e) => setSource(e.target.value)} />
        )}
        {type === 'condition' && <ConditionFields draft={draft} onChange={setDraft} allowNone={false} />}
        {(type === 'list' || type === 'listRange') && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={dropdown} onCheckedChange={(on) => setDropdown(on === true)} />
            {tv.showDropdown}
          </label>
        )}
      </Field>
      <Field label={tv.invalid}>
        <RadioGroup value={strict ? 'reject' : 'warn'} onValueChange={(v) => setStrict(v === 'reject')}>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="warn" />
            {tv.warn}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="reject" />
            {tv.reject}
          </label>
        </RadioGroup>
      </Field>
      <Field label={tv.help}>
        <Input className="h-8 text-sm" value={help} onChange={(e) => setHelp(e.target.value)} aria-label={tv.help} />
      </Field>
      <div className="flex items-center gap-2">
        {existing && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              removeValidation(controller, rule.id);
              onDone();
            }}
          >
            <Trash2 />
            {tv.remove}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            {tv.cancel}
          </Button>
          <Button size="sm" onClick={save}>
            {tv.done}
          </Button>
        </div>
      </div>
    </div>
  );
}
