/**
 * The responses table's filter popover: status, date range, version, and any
 * number of answer filters (a question, a condition, a value). The state is
 * the parent's; this only edits it.
 */

import { useMemo } from 'react';
import { Plus, SlidersHorizontal, X } from 'lucide-react';
import { choicesOf, fieldsOf, type FieldBlock } from '@weldsuite/forms-engine';
import type {
  FormDetail,
  FormResponseColumn,
  FormVersionSummary,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { useI18n } from '@/lib/i18n/provider';
import {
  EMPTY_FILTERS,
  MAX_ANSWER_FILTERS,
  activeFilterCount,
  filtersTooLong,
  isListOperator,
  needsValue,
  operatorsFor,
  type AnswerFilterDraft,
  type AnswerOperator,
  type ResponsesFilterState,
} from './filters';

const STATUSES = ['all', 'completed', 'in_progress'] as const;
const ALL_VERSIONS = '__all__';

let counter = 0;
function newKey(): string {
  counter += 1;
  return `f${counter}`;
}

export function FiltersPanel({
  form,
  columns,
  versions,
  state,
  onChange,
}: Readonly<{
  form: FormDetail;
  columns: FormResponseColumn[];
  versions: FormVersionSummary[];
  state: ResponsesFilterState;
  onChange: (state: ResponsesFilterState) => void;
}>) {
  const { t, format } = useI18n();
  const tf = t.weldformsResults.results.filters;
  const tr = t.weldformsResults.results;
  const answerColumns = useMemo(() => columns.filter((c) => c.blockId !== undefined), [columns]);
  const fields = useMemo(() => new Map(fieldsOf(form.definition).map((f) => [f.id, f])), [form.definition]);
  const count = activeFilterCount(state);

  const patch = (next: Partial<ResponsesFilterState>) => onChange({ ...state, ...next });
  const updateAnswer = (key: string, next: Partial<AnswerFilterDraft>) =>
    patch({ answers: state.answers.map((a) => (a.key === key ? { ...a, ...next } : a)) });

  function addAnswerFilter() {
    const first = answerColumns[0];
    if (!first?.blockId) return;
    patch({
      answers: [
        ...state.answers,
        {
          key: newKey(),
          blockId: first.blockId,
          ...(first.part ? { part: first.part } : {}),
          operator: operatorsFor(first.type)[0] ?? 'is',
        },
      ],
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8">
          <SlidersHorizontal className="mr-1.5 h-4 w-4" />
          {count > 0 ? format(tr.responses.filtersActive, { count }) : tr.responses.filters}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,34rem)] space-y-4">
        <p className="text-sm font-semibold">{tf.title}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="resp-status">{tf.status}</Label>
            <Select value={state.status} onValueChange={(value) => patch({ status: value as ResponsesFilterState['status'] })}>
              <SelectTrigger id="resp-status" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tf.statuses[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {versions.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="resp-version">{tr.versionFilter}</Label>
              <Select
                value={state.versionId || ALL_VERSIONS}
                onValueChange={(value) => patch({ versionId: value === ALL_VERSIONS ? '' : value })}
              >
                <SelectTrigger id="resp-version" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VERSIONS}>{tr.allVersions}</SelectItem>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {format(tr.versionLabel, { number: v.number })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{tf.date}</Label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={state.from}
                max={state.to || undefined}
                aria-label={tr.dateFrom}
                onChange={(e) => patch({ from: e.target.value })}
                className="h-8"
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="date"
                value={state.to}
                min={state.from || undefined}
                aria-label={tr.dateTo}
                onChange={(e) => patch({ to: e.target.value })}
                className="h-8"
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">{tf.answers}</p>
          {state.answers.map((draft) => {
            const column = answerColumns.find((c) => c.blockId === draft.blockId && c.part === draft.part) ?? answerColumns.find((c) => c.blockId === draft.blockId);
            const type = column?.type ?? '';
            const operators = operatorsFor(type);
            return (
              <div key={draft.key} className="space-y-2 rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={column?.key}
                    onValueChange={(key) => {
                      const next = answerColumns.find((c) => c.key === key);
                      if (!next?.blockId) return;
                      updateAnswer(draft.key, {
                        blockId: next.blockId,
                        part: next.part,
                        operator: operatorsFor(next.type)[0] ?? 'is',
                        value: undefined,
                      });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={tf.question} className="min-w-0 flex-1">
                      <SelectValue placeholder={tf.questionPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {answerColumns.map((c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={tf.removeFilter}
                    onClick={() => patch({ answers: state.answers.filter((a) => a.key !== draft.key) })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <Select
                    value={draft.operator}
                    onValueChange={(operator) =>
                      updateAnswer(draft.key, {
                        operator: operator as AnswerOperator,
                        value: isListOperator(operator as AnswerOperator) ? [] : undefined,
                      })
                    }
                  >
                    <SelectTrigger size="sm" aria-label={tf.operator} className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((operator) => (
                        <SelectItem key={operator} value={operator}>
                          {tf.operators[operator]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {needsValue(draft.operator) && (
                    <ValueInput
                      draft={draft}
                      type={type}
                      field={column?.blockId ? fields.get(column.blockId) : undefined}
                      placeholder={tf.valuePlaceholder}
                      yes={t.weldformsResults.common.yes}
                      no={t.weldformsResults.common.no}
                      onChange={(value) => updateAnswer(draft.key, { value })}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {filtersTooLong(state.answers) && <InlineError>{tf.tooLong}</InlineError>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={answerColumns.length === 0 || state.answers.length >= MAX_ANSWER_FILTERS}
            onClick={addAnswerFilter}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {tf.addAnswerFilter}
          </Button>
        </div>

        {count > 0 && (
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...EMPTY_FILTERS, q: state.q, sort: state.sort })}>
              {tr.responses.clearFilters}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ValueInput({
  draft,
  type,
  field,
  placeholder,
  yes,
  no,
  onChange,
}: Readonly<{
  draft: AnswerFilterDraft;
  type: string;
  field: FieldBlock | undefined;
  placeholder: string;
  yes: string;
  no: string;
  onChange: (value: AnswerFilterDraft['value']) => void;
}>) {
  if (isListOperator(draft.operator)) {
    const choices = field ? choicesOf(field) : [];
    const selected = Array.isArray(draft.value) ? draft.value : [];
    return (
      <ul className="max-h-36 min-w-0 flex-1 space-y-1 overflow-auto rounded-md border p-2">
        {choices.map((choice) => (
          <li key={choice.id}>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(choice.id)}
                onCheckedChange={(checked) =>
                  onChange(checked === true ? [...selected, choice.id] : selected.filter((id) => id !== choice.id))
                }
              />
              <span className="truncate">{choice.label}</span>
            </label>
          </li>
        ))}
      </ul>
    );
  }
  if (type === 'yes_no' || type === 'legal') {
    return (
      <Select value={typeof draft.value === 'boolean' ? String(draft.value) : undefined} onValueChange={(v) => onChange(v === 'true')}>
        <SelectTrigger size="sm" className="w-32">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">{yes}</SelectItem>
          <SelectItem value="false">{no}</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  const numeric = ['number', 'rating', 'opinion_scale', 'nps'].includes(type);
  return (
    <Input
      type={type === 'date' ? 'date' : numeric ? 'number' : 'text'}
      value={typeof draft.value === 'string' || typeof draft.value === 'number' ? String(draft.value) : ''}
      placeholder={placeholder}
      aria-label={placeholder}
      className="h-8 min-w-0 flex-1"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
