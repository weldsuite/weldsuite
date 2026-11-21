import { useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { FieldError } from '@weldsuite/ui/components/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  CATEGORY_RULE_COLUMNS,
  type CategoryRule,
  type CategoryRuleColumn,
  type CategoryRuleRelation,
  type CategoryRulesMatch,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { isNumberColumn, isRuleColumn, newRule, relationsFor, ruleProblem, withColumn } from '../../lib/categories';
import { CategoryMembersPreview } from './category-members-preview';

/** The server keeps at most this many rules per category. */
export const MAX_RULES = 50;

/**
 * The rules of an automated category: each tests one product field (the
 * server's whitelist) with a relation that suits the field, and the category
 * takes the products that match all or any of them. Below the rules, the
 * products they match right now.
 */
export function CategoryRulesEditor({
  rules,
  rulesMatch,
  onChange,
  showErrors,
}: Readonly<{
  rules: CategoryRule[];
  rulesMatch: CategoryRulesMatch;
  onChange: (next: { rules: CategoryRule[]; rulesMatch: CategoryRulesMatch }) => void;
  /** Mark incomplete rules (after a submit attempt). */
  showErrors: boolean;
}>) {
  const t = getTranslations('commerce').categories.rules;
  // Rules have no id: keep a React key per row, in step with add and remove.
  const nextKey = useRef(0);
  const [keys, setKeys] = useState<number[]>(() => rules.map(() => nextKey.current++));
  const list = useRef<HTMLUListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const setRules = (next: CategoryRule[]) => onChange({ rules: next, rulesMatch });
  const update = (index: number, rule: CategoryRule) => setRules(rules.map((r, i) => (i === index ? rule : r)));
  const add = () => {
    setKeys((prev) => [...prev, nextKey.current++]);
    setRules([...rules, newRule()]);
  };
  const remove = (index: number) => {
    // The focused Remove button goes with its rule: move focus to the next rule's (or the
    // previous one's), or to Add rule after the last one.
    const removeButtons = list.current?.querySelectorAll<HTMLElement>('[data-remove-rule]');
    const nextFocus = removeButtons?.[index + 1] ?? removeButtons?.[index - 1] ?? addButton.current;
    setKeys((prev) => prev.filter((_, i) => i !== index));
    setRules(rules.filter((_, i) => i !== index));
    nextFocus?.focus();
  };

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="category-rules-match">{t.matchLabel}</Label>
        <Select
          value={rulesMatch}
          onValueChange={(value) => onChange({ rules, rulesMatch: value === 'any' ? 'any' : 'all' })}
        >
          <SelectTrigger id="category-rules-match" className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.match.all}</SelectItem>
            <SelectItem value="any">{t.match.any}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ul ref={list} className="grid gap-2" aria-label={t.title}>
        {rules.map((rule, index) => (
          <RuleRow
            key={keys[index] ?? `extra-${index}`}
            rule={rule}
            showErrors={showErrors}
            onChange={(next) => update(index, next)}
            onRemove={() => remove(index)}
          />
        ))}
      </ul>

      {showErrors && rules.length === 0 && <FieldError className="text-xs">{t.needOne}</FieldError>}

      <div className="flex items-center gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          size="sm"
          disabled={rules.length >= MAX_RULES}
          data-add-rule
          onClick={add}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t.addRule}
        </Button>
        {rules.length >= MAX_RULES && <span className="text-xs text-muted-foreground">{t.maxRules}</span>}
      </div>

      <CategoryMembersPreview rules={rules} rulesMatch={rulesMatch} />
    </div>
  );
}

function RuleRow({
  rule,
  showErrors,
  onChange,
  onRemove,
}: Readonly<{
  rule: CategoryRule;
  showErrors: boolean;
  onChange: (rule: CategoryRule) => void;
  onRemove: () => void;
}>) {
  const t = getTranslations('commerce').categories.rules;
  const errorId = useId();
  const problem = showErrors ? ruleProblem(rule) : null;
  const relations = relationsFor(rule.column);
  const columnLabels: Record<CategoryRuleColumn, string> = t.columns;
  const relationLabels: Record<CategoryRuleRelation, string> = t.relations;

  return (
    <li className="grid gap-1">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
        <Select
          value={rule.column}
          onValueChange={(value) => {
            if (isRuleColumn(value)) onChange(withColumn(rule, value));
          }}
        >
          <SelectTrigger aria-label={t.column}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_RULE_COLUMNS.map((column) => (
              <SelectItem key={column} value={column}>
                {columnLabels[column]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={rule.relation}
          onValueChange={(value) => {
            const relation = relations.find((r) => r === value);
            if (relation) onChange({ ...rule, relation });
          }}
        >
          <SelectTrigger aria-label={t.relation}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {relations.map((relation) => (
              <SelectItem key={relation} value={relation}>
                {relationLabels[relation]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={t.condition}
          value={rule.condition}
          maxLength={255}
          inputMode={isNumberColumn(rule.column) ? 'decimal' : undefined}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem ? errorId : undefined}
          onChange={(e) => onChange({ ...rule, condition: e.target.value })}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t.removeRule}
          title={t.removeRule}
          data-remove-rule
          onClick={onRemove}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {problem && (
        <FieldError id={errorId} className="text-xs">
          {problem === 'number' ? t.numberRequired : t.conditionRequired}
        </FieldError>
      )}
    </li>
  );
}
