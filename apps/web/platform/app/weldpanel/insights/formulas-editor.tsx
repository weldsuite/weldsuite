/**
 * Formulas of a trends report (`A / B * 100`): up to three, each checked as it
 * is typed with the same parser the query engine uses
 * (`@weldsuite/panel-domain/expression`), so a formula the editor accepts also
 * runs. A switch hides the series and shows the formulas only.
 */

import { Plus, X } from 'lucide-react';
import { parseExpression } from '@weldsuite/panel-domain/expression';
import type { PanelTrendFormula } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';

export const MAX_FORMULAS = 3;

/**
 * A key per formula that stays with it while it is typed in and when another
 * one is removed (formulas have no id): an edited formula takes over the key
 * of the one it replaces.
 */
const formulaKeys = new WeakMap<PanelTrendFormula, number>();
let lastFormulaKey = 0;
function formulaKey(formula: PanelTrendFormula): number {
  let key = formulaKeys.get(formula);
  if (key === undefined) {
    lastFormulaKey += 1;
    key = lastFormulaKey;
    formulaKeys.set(formula, key);
  }
  return key;
}

/** Why a formula does not parse for `seriesCount` series, as `{ message, position }` (1-based), or null. */
export function formulaProblem(expression: string, seriesCount: number): { message: string; position: number } | null {
  if (expression.trim() === '') return null;
  const parsed = parseExpression(expression, { identifiers: 'series', seriesCount });
  return parsed.ok ? null : { message: parsed.error.message, position: parsed.error.position + 1 };
}

/** The formulas a query can run: non-empty and parsing; null when one of them does not. */
export function runnableFormulas(formulas: readonly PanelTrendFormula[] | undefined, seriesCount: number): PanelTrendFormula[] | null {
  const filled = (formulas ?? []).filter((f) => f.expression.trim() !== '');
  if (filled.some((f) => formulaProblem(f.expression, seriesCount) !== null)) return null;
  return filled.map((f) => ({ expression: f.expression.trim(), ...(f.label?.trim() ? { label: f.label.trim() } : {}) }));
}

interface FormulasEditorProps {
  formulas: PanelTrendFormula[];
  onChange: (formulas: PanelTrendFormula[]) => void;
  formulaOnly: boolean;
  onFormulaOnlyChange: (value: boolean) => void;
  seriesCount: number;
  /** The label under the formula instead of beside it, for a narrow column. */
  stacked?: boolean;
}

export function FormulasEditor({ formulas, onChange, formulaOnly, onFormulaOnlyChange, seriesCount, stacked = false }: Readonly<FormulasEditorProps>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.insights.formulas;
  const update = (index: number, patch: Partial<PanelTrendFormula>) =>
    onChange(
      formulas.map((f, i) => {
        if (i !== index) return f;
        const next = { ...f, ...patch };
        formulaKeys.set(next, formulaKey(f));
        return next;
      }),
    );

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">{tx.hint}</p>
      {formulas.map((formula, index) => {
        const n = index + 1;
        const problem = formulaProblem(formula.expression, seriesCount);
        const errorId = `weldpanel-formula-${index}-error`;
        return (
          <div
            key={formulaKey(formula)}
            className={stacked ? 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border p-3' : 'grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_14rem_auto] sm:items-start'}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`weldpanel-formula-${index}`}>{format(tx.expression, { n })}</Label>
              <Input
                id={`weldpanel-formula-${index}`}
                value={formula.expression}
                onChange={(event) => update(index, { expression: event.target.value })}
                placeholder="A / B * 100"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                maxLength={500}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? errorId : undefined}
              />
              {problem && (
                <p id={errorId} className="text-xs text-destructive">
                  {format(tx.invalid, { position: problem.position, message: problem.message })}
                </p>
              )}
            </div>
            <div className={stacked ? 'col-start-1 grid gap-1.5' : 'grid gap-1.5'}>
              <Label htmlFor={`weldpanel-formula-${index}-label`}>{tx.label}</Label>
              <Input
                id={`weldpanel-formula-${index}-label`}
                value={formula.label ?? ''}
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder={tx.labelPlaceholder}
                maxLength={100}
                autoComplete="off"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={stacked ? 'col-start-2 row-start-1 mt-6 size-8' : 'size-8 sm:mt-6'}
              aria-label={format(tx.remove, { n })}
              onClick={() => {
                const next = formulas.filter((_, i) => i !== index);
                onChange(next);
                if (next.length === 0) onFormulaOnlyChange(false);
              }}
            >
              <X />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {formulas.length < MAX_FORMULAS ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...formulas, { expression: '' }])}>
            <Plus />
            {tx.add}
          </Button>
        ) : (
          <span />
        )}
        {formulas.length > 0 && (
          <div className="flex items-center gap-2" title={tx.onlyHint}>
            <Switch id="weldpanel-formula-only" checked={formulaOnly} onCheckedChange={onFormulaOnlyChange} />
            <Label htmlFor="weldpanel-formula-only" className="text-sm font-normal">
              {tx.only}
            </Label>
          </div>
        )}
      </div>
    </div>
  );
}
