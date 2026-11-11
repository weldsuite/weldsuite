/**
 * Hidden fields (values that arrive through the URL or an embed) and variables
 * (numbers or text that calculations change; `score` always exists).
 */

import { Plus, Trash2 } from 'lucide-react';
import type { FormDefinition, FormVariable } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useFormEditor } from '../editor-context';

const HIDDEN_PATTERN = /^[a-zA-Z_]\w*$/;
const VARIABLE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A name not used yet: `base`, `base_2`, … */
export function freeName(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Renames a variable in the calculations, conditions and operands that use it. */
export function renameVariable(def: FormDefinition, from: string, to: string): FormDefinition {
  const json = JSON.stringify(def.logic).concat('');
  if (from === to || !json.includes(from)) return { ...def, variables: def.variables.map((v) => (v.name === from ? { ...v, name: to } : v)) };
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(record)) out[key] = rewrite(v);
      if (record.type === 'variable' && record.name === from) out.name = to;
      if (typeof record.variable === 'string' && record.variable === from) out.variable = to;
      return out;
    }
    return value;
  };
  return {
    ...def,
    variables: def.variables.map((v) => (v.name === from ? { ...v, name: to } : v)),
    logic: rewrite(def.logic) as FormDefinition['logic'],
    endingRules: rewrite(def.endingRules) as FormDefinition['endingRules'],
  };
}

export function DataDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const td = t.weldforms.data;
  const editor = useFormEditor();
  const { definition: def, canEdit } = editor;

  const patchVariable = (index: number, variable: FormVariable) => editor.editDefinition((d) => ({ ...d, variables: d.variables.map((v, i) => (i === index ? variable : v)) }), `var:${index}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{td.title}</DialogTitle>
          <DialogDescription>{td.description}</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{td.hiddenTitle}</h3>
          <p className="text-xs text-muted-foreground">{td.hiddenHelp}</p>
          <ul className="space-y-1.5">
            {def.hidden.map((hidden, index) => {
              const invalid = !HIDDEN_PATTERN.test(hidden.name) || def.hidden.some((h, i) => i !== index && h.name === hidden.name);
              return (
                <li key={index} className="flex items-center gap-1">
                  <Input
                    value={hidden.name}
                    onChange={(e) => editor.editDefinition((d) => ({ ...d, hidden: d.hidden.map((h, i) => (i === index ? { name: e.target.value } : h)) }), `hidden:${index}`)}
                    aria-label={td.hiddenName}
                    aria-invalid={invalid}
                    maxLength={64}
                    disabled={!canEdit}
                    className="h-8 font-mono text-xs"
                  />
                  {canEdit && (
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => editor.editDefinition((d) => ({ ...d, hidden: d.hidden.filter((_, i) => i !== index) }))} aria-label={t.common.actions.remove}>
                      <Trash2 />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={() => editor.editDefinition((d) => ({ ...d, hidden: [...d.hidden, { name: freeName(d.hidden.map((h) => h.name), 'utm_source') }] }))}>
              <Plus className="size-4" />
              {td.addHidden}
            </Button>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{td.variablesTitle}</h3>
          <p className="text-xs text-muted-foreground">{td.variablesHelp}</p>
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-sm">
            <code className="text-xs">score</code>
            <span className="text-xs text-muted-foreground">{td.scoreBuiltIn}</span>
          </div>
          <ul className="space-y-1.5">
            {def.variables.map((variable, index) => {
              const invalid =
                !VARIABLE_PATTERN.test(variable.name) || variable.name === 'score' || def.variables.some((v, i) => i !== index && v.name === variable.name);
              return (
                <li key={index} className="flex items-center gap-1">
                  <Input
                    value={variable.name}
                    onChange={(e) => editor.editDefinition((d) => renameVariable(d, variable.name, e.target.value), `varname:${index}`)}
                    aria-label={td.variableName}
                    aria-invalid={invalid}
                    maxLength={64}
                    disabled={!canEdit}
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <Select
                    value={variable.type}
                    disabled={!canEdit}
                    onValueChange={(type) => patchVariable(index, type === 'number' ? { name: variable.name, type: 'number', initial: 0 } : { name: variable.name, type: 'text', initial: '' })}
                  >
                    <SelectTrigger size="sm" className="w-28" aria-label={td.variableType}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="number">{td.number}</SelectItem>
                      <SelectItem value="text">{td.text}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    value={String(variable.initial)}
                    onChange={(e) =>
                      patchVariable(index, variable.type === 'number' ? { ...variable, initial: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0 } : { ...variable, initial: e.target.value })
                    }
                    aria-label={td.initial}
                    disabled={!canEdit}
                    className="h-8 w-20"
                  />
                  {canEdit && (
                    <Button type="button" variant="ghost" size="icon-xs" onClick={() => editor.editDefinition((d) => ({ ...d, variables: d.variables.filter((_, i) => i !== index) }))} aria-label={t.common.actions.remove}>
                      <Trash2 />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {canEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => editor.editDefinition((d) => ({ ...d, variables: [...d.variables, { name: freeName(['score', ...d.variables.map((v) => v.name)], 'total'), type: 'number', initial: 0 }] }))}
            >
              <Plus className="size-4" />
              {td.addVariable}
            </Button>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
