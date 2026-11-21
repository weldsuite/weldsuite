/**
 * Goals of the web overview: up to five events or pages to count conversions
 * for. They live in the page address (`?goals=`), so a reload, a bookmark or a
 * shared link keeps them, and they reach the query as the web spec's `goals`.
 */

import { useEffect, useState } from 'react';
import { Plus, Target, X } from 'lucide-react';
import { z } from 'zod';
import { panelWebGoalSchema, type PanelWebGoal, type PanelWebGoalResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber, formatPercent } from '../../lib/format';
import { LabeledField } from '../labeled-field';
import { EventPicker } from '../pickers';

export const MAX_GOALS = 5;
const goalsSchema = z.array(panelWebGoalSchema).max(MAX_GOALS);

/** The goals in a `goals` search param (JSON); anything that does not parse is ignored. */
export function parseGoalsParam(value: string | null): PanelWebGoal[] {
  if (!value) return [];
  try {
    const parsed = goalsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data.map((g) => ({ label: g.label, ...(g.event ? { event: g.event } : {}), ...(g.pathPattern ? { pathPattern: g.pathPattern } : {}), ...(g.filters.length > 0 ? { filters: g.filters } : {}) })) : [];
  } catch {
    return [];
  }
}

interface GoalDraft {
  label: string;
  type: 'event' | 'page';
  event: string;
  pathPattern: string;
}

function toDraft(goal: PanelWebGoal): GoalDraft {
  return { label: goal.label, type: goal.pathPattern ? 'page' : 'event', event: goal.event ?? '', pathPattern: goal.pathPattern ?? '' };
}

/** The goals a set of drafts stands for, or null when one is incomplete. */
export function goalsFromDrafts(drafts: readonly GoalDraft[]): PanelWebGoal[] | null {
  const goals: PanelWebGoal[] = drafts.map((d) => (d.type === 'event' ? { label: d.label.trim(), event: d.event } : { label: d.label.trim(), pathPattern: d.pathPattern.trim() }));
  return goalsSchema.safeParse(goals).success ? goals : null;
}

interface GoalsDialogProps {
  projectId: string;
  goals: PanelWebGoal[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (goals: PanelWebGoal[]) => void;
}

export function GoalsDialog({ projectId, goals, open, onOpenChange, onApply }: Readonly<GoalsDialogProps>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.overview.goals;
  const tc = t.weldpanel.analytics.common;
  const [drafts, setDrafts] = useState<GoalDraft[]>([]);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInvalid(false);
    setDrafts(goals.length > 0 ? goals.map(toDraft) : [{ label: '', type: 'event', event: '', pathPattern: '' }]);
  }, [open, goals]);

  const update = (index: number, patch: Partial<GoalDraft>) => setDrafts((list) => list.map((d, i) => (i === index ? { ...d, ...patch } : d)));

  function apply(event: React.FormEvent) {
    event.preventDefault();
    const next = goalsFromDrafts(drafts);
    if (!next) return setInvalid(true);
    onApply(next);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tx.dialogTitle}</DialogTitle>
          <DialogDescription>{tx.dialogDescription}</DialogDescription>
        </DialogHeader>
        <form onSubmit={apply} noValidate className="grid gap-4">
          <ol className="grid gap-3">
            {drafts.map((draft, index) => {
              const n = index + 1;
              const id = `weldpanel-goal-${index}`;
              return (
                <li key={index} className="flex items-start gap-2 rounded-lg border p-3" aria-label={format(tx.goalN, { n })}>
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
                    <LabeledField label={tx.label} htmlFor={`${id}-label`}>
                      <Input id={`${id}-label`} value={draft.label} onChange={(e) => update(index, { label: e.target.value })} placeholder={tx.labelPlaceholder} maxLength={100} autoComplete="off" />
                    </LabeledField>
                    <LabeledField label={tx.type} htmlFor={`${id}-type`}>
                      <Select value={draft.type} onValueChange={(type) => update(index, { type: type as GoalDraft['type'] })}>
                        <SelectTrigger id={`${id}-type`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="event">{tx.types.event}</SelectItem>
                          <SelectItem value="page">{tx.types.page}</SelectItem>
                        </SelectContent>
                      </Select>
                    </LabeledField>
                    {draft.type === 'event' ? (
                      <LabeledField label={tx.event} htmlFor={`${id}-event`}>
                        <EventPicker
                          id={`${id}-event`}
                          projectId={projectId}
                          value={draft.event}
                          onChange={(event) => update(index, { event, label: draft.label || (event.startsWith('@') ? '' : event) })}
                          ariaLabel={`${tx.event} ${n}`}
                        />
                      </LabeledField>
                    ) : (
                      <LabeledField label={tx.pathPattern} htmlFor={`${id}-path`} hint={tx.pathPatternHint}>
                        <Input id={`${id}-path`} value={draft.pathPattern} onChange={(e) => update(index, { pathPattern: e.target.value })} placeholder="/checkout/*/done" maxLength={500} autoComplete="off" />
                      </LabeledField>
                    )}
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="mt-6 size-8 shrink-0" aria-label={format(tx.remove, { n })} onClick={() => setDrafts((list) => list.filter((_, i) => i !== index))}>
                    <X />
                  </Button>
                </li>
              );
            })}
          </ol>
          {drafts.length < MAX_GOALS && (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setDrafts((list) => [...list, { label: '', type: 'event', event: '', pathPattern: '' }])}>
                <Plus />
                {tx.add}
              </Button>
            </div>
          )}
          {invalid && <InfoBanner variant="danger">{tx.invalid}</InfoBanner>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tc.cancel}
            </Button>
            <Button type="submit">{tx.apply}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The goals' conversions, unique converters and conversion rate. */
export function GoalsTable({ goals }: Readonly<{ goals: PanelWebGoalResult[] | undefined }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.overview.goals;
  if (!goals || goals.length === 0) {
    return (
      <EmptyText>
        <span className="inline-flex items-center gap-2">
          <Target className="size-4" aria-hidden />
          {tx.empty}
        </span>
      </EmptyText>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tx.columns.goal}</TableHead>
          <TableHead className="text-right">{tx.columns.conversions}</TableHead>
          <TableHead className="text-right">{tx.columns.converters}</TableHead>
          <TableHead className="text-right">{tx.columns.rate}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {goals.map((goal, index) => (
          <TableRow key={`${index}:${goal.label}`}>
            <TableCell className="max-w-64 truncate font-medium">{goal.label}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(goal.conversions, language)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(goal.uniqueConverters, language)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(goal.conversionRate, language)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
