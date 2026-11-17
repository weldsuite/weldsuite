/**
 * Path cleaning: ordered rules (a regular expression and its replacement)
 * that turn `/users/123` into `/users/:id` wherever reports group pages by
 * path. Edited as a list (drag to reorder) and saved as a whole; a test box
 * shows sample paths before and after the rules as they are on screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Route, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  PANEL_MAX_PATH_RULES,
  panelPathPatternProblem,
  panelPathReplacementProblem,
  type PanelPathRuleDto,
  type PanelPathRuleTestResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SortableList } from '@weldsuite/ui/components/sortable-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useReplaceWeldPanelPathRules, useTestWeldPanelPathRules, useWeldPanelPathRules } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';

interface RuleDraft {
  /** Local, for the list's keys while rows move. */
  key: string;
  pattern: string;
  replacement: string;
  description: string;
}

let nextKey = 0;
function newKey(): string {
  nextKey += 1;
  return `rule-${nextKey}`;
}

function draftsFrom(rules: readonly PanelPathRuleDto[]): RuleDraft[] {
  return [...rules].sort((a, b) => a.position - b.position).map((r) => ({ key: r.id, pattern: r.pattern, replacement: r.replacement, description: r.description ?? '' }));
}

function sameRules(a: readonly RuleDraft[], b: readonly RuleDraft[]): boolean {
  return a.length === b.length && a.every((r, i) => r.pattern === b[i]!.pattern && r.replacement === b[i]!.replacement && r.description === b[i]!.description);
}

function asInput(rules: readonly RuleDraft[]) {
  return rules.map((r) => ({ pattern: r.pattern, replacement: r.replacement, description: r.description.trim() === '' ? null : r.description.trim() }));
}

function TestBox({ projectId, rules }: Readonly<{ projectId: string; rules: readonly RuleDraft[] }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.data.pathRules.test;
  const [text, setText] = useState('');
  const test = useTestWeldPanelPathRules();
  const [results, setResults] = useState<PanelPathRuleTestResult[] | null>(null);
  const paths = text
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .slice(0, 50);
  const runnable = rules.filter((r) => panelPathPatternProblem(r.pattern) === null && panelPathReplacementProblem(r.replacement) === null);

  async function run() {
    try {
      setResults(await test.mutateAsync({ projectId, rules: asInput(runnable), paths }));
    } catch {
      setResults(null);
    }
  }

  return (
    <SectionCard title={tx.title}>
      <div className="grid gap-3">
        <LabeledField label={tx.title} htmlFor="weldpanel-path-test" hint={tx.hint}>
          <Textarea id="weldpanel-path-test" value={text} onChange={(e) => setText(e.target.value)} placeholder={tx.placeholder} rows={4} className="font-mono text-sm" spellCheck={false} />
        </LabeledField>
        <div>
          <Button type="button" variant="outline" size="sm" disabled={paths.length === 0 || test.isPending} onClick={() => void run()}>
            {test.isPending && <InlineSpinner />}
            {tx.run}
          </Button>
        </div>
        {test.isError && <InfoBanner variant="danger">{tx.failed}</InfoBanner>}
        {results && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx.path}</TableHead>
                  <TableHead>{tx.cleaned}</TableHead>
                  <TableHead>{tx.matched}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r, i) => (
                  <TableRow key={`${i}:${r.path}`}>
                    <TableCell className="max-w-72 truncate font-mono text-xs">{r.path}</TableCell>
                    <TableCell className="max-w-72 truncate font-mono text-xs">{r.matched.length === 0 ? <span className="text-muted-foreground">{tx.unchanged}</span> : r.cleaned}</TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">{r.matched.map((m) => m + 1).join(', ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

export function PathRulesTab({ projectId, canChange }: Readonly<{ projectId: string; canChange: boolean }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.data.pathRules;
  const tc = t.weldpanel.analytics.common;
  const { data, isLoading, isError, refetch } = useWeldPanelPathRules(projectId);
  const replace = useReplaceWeldPanelPathRules(projectId);
  const saved = useMemo(() => draftsFrom(data ?? []), [data]);
  const [rules, setRules] = useState<RuleDraft[]>([]);

  // The list follows what is saved until it is edited.
  useEffect(() => setRules(saved), [saved]);

  const dirty = !sameRules(rules, saved);
  const problems = rules.map((r) => panelPathPatternProblem(r.pattern) ?? panelPathReplacementProblem(r.replacement));
  const update = (index: number, patch: Partial<RuleDraft>) => setRules((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRules((list) => {
      const target = index + by;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  async function save() {
    try {
      await replace.mutateAsync({ rules: asInput(rules) });
      toast.success(tx.saved);
    } catch {
      toast.error(tx.saveFailed);
    }
  }

  return (
    <div className="grid gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">{tx.description}</p>

      {rules.length === 0 ? (
        <EmptyState icon={Route} title={tx.empty} />
      ) : (
        <SortableList
          items={rules}
          getId={(r) => r.key}
          onReorder={setRules}
          disabled={!canChange}
          handleLabel={(_, index) => format(tx.drag, { n: index + 1 })}
          renderItem={(rule, index) => {
            const n = index + 1;
            const id = `weldpanel-path-rule-${rule.key}`;
            return (
              <div className="grid gap-2" role="group" aria-label={format(tx.rule, { n })}>
                <div className="flex items-start gap-2">
                  <span className="mt-7 w-5 shrink-0 text-xs tabular-nums text-muted-foreground" aria-hidden>
                    {n}
                  </span>
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
                    <LabeledField label={tx.pattern} htmlFor={`${id}-pattern`}>
                      <Input
                        id={`${id}-pattern`}
                        value={rule.pattern}
                        onChange={(e) => update(index, { pattern: e.target.value })}
                        placeholder={tx.patternPlaceholder}
                        className="font-mono"
                        disabled={!canChange}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={problems[index] ? true : undefined}
                      />
                    </LabeledField>
                    <LabeledField label={tx.replacement} htmlFor={`${id}-replacement`}>
                      <Input
                        id={`${id}-replacement`}
                        value={rule.replacement}
                        onChange={(e) => update(index, { replacement: e.target.value })}
                        placeholder={tx.replacementPlaceholder}
                        className="font-mono"
                        disabled={!canChange}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </LabeledField>
                    <LabeledField label={`${tx.note} (${tc.optional})`} htmlFor={`${id}-note`}>
                      <Input id={`${id}-note`} value={rule.description} onChange={(e) => update(index, { description: e.target.value })} disabled={!canChange} maxLength={500} autoComplete="off" />
                    </LabeledField>
                  </div>
                  {canChange && (
                    <div className="mt-6 flex shrink-0 gap-0.5">
                      <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === 0} aria-label={format(tx.moveUp, { n })} onClick={() => move(index, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === rules.length - 1} aria-label={format(tx.moveDown, { n })} onClick={() => move(index, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={format(tx.remove, { n })} onClick={() => setRules((list) => list.filter((_, i) => i !== index))}>
                        <X />
                      </Button>
                    </div>
                  )}
                </div>
                {problems[index] && rule.pattern !== '' && <p className="pl-7 text-xs text-destructive">{problems[index]}</p>}
              </div>
            );
          }}
        />
      )}

      {canChange && (
        <div className="flex flex-wrap items-center gap-2">
          {rules.length < PANEL_MAX_PATH_RULES ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setRules((list) => [...list, { key: newKey(), pattern: '', replacement: '', description: '' }])}>
              <Plus />
              {tx.add}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{format(tx.max, { count: PANEL_MAX_PATH_RULES })}</p>
          )}
          {dirty && (
            <>
              <span className="ml-auto text-xs text-muted-foreground">{tx.unsaved}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRules(saved)} disabled={replace.isPending}>
                {tx.discard}
              </Button>
              <Button type="button" size="sm" onClick={() => void save()} disabled={replace.isPending || problems.some((p) => p !== null)}>
                {replace.isPending && <InlineSpinner />}
                {tx.save}
              </Button>
            </>
          )}
        </div>
      )}

      <TestBox projectId={projectId} rules={rules} />
    </div>
  );
}
