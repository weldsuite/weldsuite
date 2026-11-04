import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { FlowWorkspaceSettings, ScoringCriterionInput } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useSaveIntakeSettings } from '@/hooks/queries/use-flow-portfolio-queries';
import { weightTotal } from '../_lib/intake';

interface ModelCardProps {
  settings: FlowWorkspaceSettings;
  /** `portfolio:manage`: the weights and the board are editable. */
  canEdit: boolean;
  nameOf: (id: string) => string;
  people: Array<{ value: string; label: string }>;
}

/** The workspace scoring model (weights adding up to 100), the portfolio board and the expense limit. */
export function ModelCard({ settings, canEdit, nameOf, people }: Readonly<ModelCardProps>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.intake.model;
  const save = useSaveIntakeSettings();
  const [model, setModel] = useState<ScoringCriterionInput[]>(settings.scoringModel);
  const [board, setBoard] = useState<string[]>(settings.portfolioBoardIds);
  const [limit, setLimit] = useState(settings.expenseApprovalLimit ?? '');
  useEffect(() => {
    setModel(settings.scoringModel);
    setBoard(settings.portfolioBoardIds);
    setLimit(settings.expenseApprovalLimit ?? '');
  }, [settings]);

  const total = weightTotal(model);
  const valid = total === 100;
  const setWeight = (key: string, text: string) => {
    const weight = Math.max(0, Math.min(100, Math.round(Number(text) || 0)));
    setModel((current) => current.map((c) => (c.key === key ? { ...c, weight } : c)));
  };
  const submit = () =>
    save.mutate(
      { scoringModel: model, portfolioBoardIds: board, expenseApprovalLimit: limit.trim() === '' ? null : Number(limit) },
      { onSuccess: () => toast.success(copy.saved), onError: () => toast.error(t.flowPortfolio.common.saveFailed) },
    );

  return (
    <section aria-labelledby="model-title" className="rounded-lg border bg-card px-4 py-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 id="model-title" className="flex-1 text-sm font-semibold">
          {copy.title}
        </h2>
        <span
          className={cn(
            'rounded-full px-2 py-px text-xs font-medium',
            valid ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
          )}
        >
          {format(copy.total, { total })}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {model.map((criterion) => (
          <label key={criterion.key} className="grid grid-cols-[minmax(0,1fr)_72px] items-center gap-2 text-[13px]">
            <span>
              {criterion.label}
              {criterion.inverse ? <span className="text-xs text-muted-foreground"> ({copy.inverse})</span> : null}
            </span>
            <span className="inline-flex items-center gap-1">
              <Input
                inputMode="numeric"
                aria-label={format(copy.weight, { label: criterion.label })}
                className="h-8 w-12 px-1.5 text-right"
                value={criterion.weight}
                disabled={!canEdit}
                onChange={(event) => setWeight(criterion.key, event.target.value)}
              />
              <span className="text-xs text-muted-foreground">%</span>
            </span>
          </label>
        ))}
      </div>
      {valid ? <p className="mt-2.5 text-xs text-muted-foreground">{copy.hint}</p> : <p role="alert" className="mt-2.5 text-xs text-destructive">{format(copy.invalid, { total })}</p>}

      <h3 className="mt-4 text-[13px] font-semibold">{copy.board}</h3>
      <p className="text-xs text-muted-foreground">{copy.boardHint}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {board.map((id) => (
          <li key={id} className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs">
            {nameOf(id)}
            {canEdit ? (
              <button type="button" aria-label={format(copy.removeMember, { name: nameOf(id) })} onClick={() => setBoard(board.filter((b) => b !== id))} className="rounded-full p-0.5 hover:bg-background">
                <X className="size-3" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="mt-2">
          <Select value="" onValueChange={(id) => setBoard(board.includes(id) ? board : [...board, id])}>
            <SelectTrigger aria-label={copy.addMember} className="h-8 w-full text-[13px]">
              <SelectValue placeholder={copy.addMember} />
            </SelectTrigger>
            <SelectContent>
              {people
                .filter((p) => !board.includes(p.value))
                .map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <label className="mt-4 block text-[13px]">
        <span className="font-semibold">{copy.limit}</span>
        <Input inputMode="decimal" className="mt-1.5 h-8" value={limit} disabled={!canEdit} onChange={(event) => setLimit(event.target.value)} />
      </label>
      {canEdit ? (
        <Button className="mt-3 w-full" disabled={!valid || save.isPending} onClick={submit}>
          {copy.save}
        </Button>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">{copy.readOnly}</p>
      )}
    </section>
  );
}
