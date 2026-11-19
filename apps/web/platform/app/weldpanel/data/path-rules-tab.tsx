/**
 * Path cleaning: ordered rules (a regular expression and its replacement)
 * that turn `/users/123` into `/users/:id` wherever reports group pages by
 * path. Edited in the standard list (fields in the row, arrows to reorder) and
 * saved as a whole; a test row above the list shows sample paths before and
 * after the rules as they are on screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Route } from 'lucide-react';
import { toast } from 'sonner';
import {
  PANEL_MAX_PATH_RULES,
  panelPathPatternProblem,
  panelPathReplacementProblem,
  type PanelPathRuleDto,
  type PanelPathRuleTestResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner, PageLoader } from '@weldsuite/ui/components/page-loader';
import { useReplaceWeldPanelPathRules, useTestWeldPanelPathRules, useWeldPanelPathRules } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface RuleDraft {
  /** Local, for the list's keys while rows move. */
  id: string;
  pattern: string;
  replacement: string;
  description: string;
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `rule-${nextId}`;
}

function draftsFrom(rules: readonly PanelPathRuleDto[]): RuleDraft[] {
  return [...rules].sort((a, b) => a.position - b.position).map((r) => ({ id: r.id, pattern: r.pattern, replacement: r.replacement, description: r.description ?? '' }));
}

function sameRules(a: readonly RuleDraft[], b: readonly RuleDraft[]): boolean {
  return a.length === b.length && a.every((r, i) => r.pattern === b[i]!.pattern && r.replacement === b[i]!.replacement && r.description === b[i]!.description);
}

function asInput(rules: readonly RuleDraft[]) {
  return rules.map((r) => ({ pattern: r.pattern, replacement: r.replacement, description: r.description.trim() === '' ? null : r.description.trim() }));
}

interface TestRow extends PanelPathRuleTestResult {
  id: string;
}

/** One toolbar-height row: a path, "Try", and what the rules as they are on screen make of it. */
function PathTester({ projectId, rules }: Readonly<{ projectId: string; rules: readonly RuleDraft[] }>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.data.pathRules.test;
  const [text, setText] = useState('');
  const test = useTestWeldPanelPathRules();
  const [results, setResults] = useState<TestRow[] | null>(null);
  const paths = text
    .split(/[\s,]+/)
    .filter((p) => p !== '')
    .slice(0, 50);
  const runnable = rules.filter((r) => panelPathPatternProblem(r.pattern) === null && panelPathReplacementProblem(r.replacement) === null);

  async function run() {
    try {
      const found = await test.mutateAsync({ projectId, rules: asInput(runnable), paths });
      setResults(found.map((r, i) => ({ ...r, id: `${i}:${r.path}` })));
    } catch {
      setResults(null);
    }
  }

  const columns: ColumnDef<TestRow>[] = [
    { id: 'path', header: tx.path, width: 'flex-1 min-w-[160px]', render: (r) => <span className="block truncate font-mono text-xs">{r.path}</span> },
    {
      id: 'cleaned',
      header: tx.cleaned,
      width: 'flex-1 min-w-[160px]',
      render: (r) => <span className="block truncate font-mono text-xs">{r.matched.length === 0 ? <span className="text-muted-foreground">{tx.unchanged}</span> : r.cleaned}</span>,
    },
    {
      id: 'matched',
      header: tx.matched,
      width: 'hidden sm:block sm:w-[120px]',
      render: (r) => <span className="text-xs tabular-nums text-muted-foreground">{r.matched.map((m) => m + 1).join(', ')}</span>,
    },
  ];

  return (
    <>
      <form
        className="flex h-[53px] items-center gap-2 border-b border-border px-3 md:px-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (paths.length > 0 && !test.isPending) void run();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={tx.placeholder.split('\n')[0]}
          aria-label={tx.title}
          title={tx.hint}
          className="h-8 max-w-md font-mono text-sm"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" variant="outline" size="sm" className="h-8" disabled={paths.length === 0 || test.isPending}>
          {test.isPending && <InlineSpinner />}
          {tx.run}
        </Button>
        {test.isError && <span className="text-xs text-destructive">{tx.failed}</span>}
      </form>
      {results && <PanelEntityList<TestRow> items={results} isLoading={false} columns={columns} hideTopBar hideFilter emptyState={{ title: tx.unchanged, description: '' }} />}
    </>
  );
}

export function PathRulesTab({ projectId, canChange }: Readonly<{ projectId: string; canChange: boolean }>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.data.pathRules;
  const { data, isLoading, isError, refetch } = useWeldPanelPathRules(projectId);
  const replace = useReplaceWeldPanelPathRules(projectId);
  const saved = useMemo(() => draftsFrom(data ?? []), [data]);
  const [rules, setRules] = useState<RuleDraft[]>([]);

  // The list follows what is saved until it is edited.
  useEffect(() => setRules(saved), [saved]);

  const dirty = !sameRules(rules, saved);
  const problems = rules.map((r) => panelPathPatternProblem(r.pattern) ?? panelPathReplacementProblem(r.replacement));
  const firstProblem = problems.findIndex((p, i) => p !== null && rules[i]?.pattern !== '');
  const update = (id: string, patch: Partial<RuleDraft>) => setRules((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRules((list) => {
      const target = index + by;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={tx.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  async function save() {
    try {
      await replace.mutateAsync({ rules: asInput(rules) });
      toast.success(tx.saved);
    } catch {
      toast.error(tx.saveFailed);
    }
  }

  const indexOf = (rule: RuleDraft) => rules.findIndex((r) => r.id === rule.id);

  const columns: ColumnDef<RuleDraft>[] = [
    {
      id: 'order',
      header: '#',
      width: 'w-[32px]',
      render: (rule) => <span className="text-xs tabular-nums text-muted-foreground">{indexOf(rule) + 1}</span>,
    },
    {
      id: 'pattern',
      header: tx.pattern,
      width: 'flex-1 min-w-[160px]',
      render: (rule) => (
        <Input
          value={rule.pattern}
          onChange={(e) => update(rule.id, { pattern: e.target.value })}
          placeholder={tx.patternPlaceholder}
          aria-label={tx.pattern}
          className="h-8 font-mono"
          disabled={!canChange}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problems[indexOf(rule)] ? true : undefined}
        />
      ),
    },
    {
      id: 'replacement',
      header: tx.replacement,
      width: 'hidden sm:block sm:w-[220px]',
      render: (rule) => (
        <Input
          value={rule.replacement}
          onChange={(e) => update(rule.id, { replacement: e.target.value })}
          placeholder={tx.replacementPlaceholder}
          aria-label={tx.replacement}
          className="h-8 font-mono"
          disabled={!canChange}
          spellCheck={false}
          autoComplete="off"
        />
      ),
    },
    {
      id: 'note',
      header: tx.note,
      width: 'hidden lg:block lg:w-[220px]',
      render: (rule) => <Input value={rule.description} onChange={(e) => update(rule.id, { description: e.target.value })} aria-label={tx.note} className="h-8" disabled={!canChange} maxLength={500} autoComplete="off" />,
    },
    ...(canChange
      ? [
          {
            id: 'order-buttons',
            header: '',
            width: 'w-[64px]',
            render: (rule: RuleDraft) => {
              const index = indexOf(rule);
              const n = index + 1;
              return (
                <div className="flex gap-0.5">
                  <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === 0} aria-label={format(tx.moveUp, { n })} onClick={() => move(index, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === rules.length - 1} aria-label={format(tx.moveDown, { n })} onClick={() => move(index, 1)}>
                    <ArrowDown />
                  </Button>
                </div>
              );
            },
          },
        ]
      : []),
  ];

  const addRule = () => setRules((list) => [...list, { id: newId(), pattern: '', replacement: '', description: '' }]);
  const canAdd = canChange && rules.length < PANEL_MAX_PATH_RULES;

  return (
    <>
      <PathTester projectId={projectId} rules={rules} />
      {firstProblem >= 0 && (
        <p className="border-b border-border px-3 py-2 text-xs text-destructive md:px-4">
          <span className="font-medium">{format(tx.rule, { n: firstProblem + 1 })}</span> <span>{problems[firstProblem]}</span>
        </p>
      )}
      <PanelEntityList<RuleDraft>
        items={rules}
        isLoading={false}
        columns={columns}
        hideFilter
        onDelete={canChange ? (rule) => setRules((list) => list.filter((r) => r.id !== rule.id)) : undefined}
        createButton={canAdd ? { label: tx.add, onClick: addRule } : undefined}
        actionButtons={
          <>
            {canChange && rules.length >= PANEL_MAX_PATH_RULES && <span className="hidden text-xs text-muted-foreground lg:inline">{format(tx.max, { count: PANEL_MAX_PATH_RULES })}</span>}
            {canChange && dirty && (
              <>
                <span className="hidden text-xs text-muted-foreground lg:inline">{tx.unsaved}</span>
                <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setRules(saved)} disabled={replace.isPending}>
                  {tx.discard}
                </Button>
                <Button type="button" size="sm" className="h-8" onClick={() => void save()} disabled={replace.isPending || problems.some((p) => p !== null)}>
                  {replace.isPending && <InlineSpinner />}
                  {tx.save}
                </Button>
              </>
            )}
          </>
        }
        emptyState={{ icon: <Route className="size-8 text-muted-foreground" />, title: tx.empty, description: tx.description, action: canAdd ? { label: tx.add, onClick: addRule } : undefined }}
      />
    </>
  );
}
