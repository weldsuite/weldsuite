import { useState, type ReactNode } from 'react';
import { getTranslations } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useDeskProblemSearch, type DeskProblem } from '@/hooks/queries/use-desk-problem-queries';
import { ProblemStatusBadge } from '../problems/problem-status-badge';

/** Pick the problem a ticket belongs to from a search over the problems that still take tickets. */
export function ProblemPickerDialog({
  open,
  onOpenChange,
  exclude,
  disabled,
  notice,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The problem the ticket has already. */
  exclude?: string | null;
  disabled?: boolean;
  /** Shown above the list (a refusal from the last pick). */
  notice?: ReactNode;
  onPick: (problem: DeskProblem) => void;
}>) {
  const t = getTranslations('deskProblems').inbox;
  const [query, setQuery] = useState('');
  const { data, isFetching } = useDeskProblemSearch(query, open);
  const results = (data ?? []).filter((problem) => problem.id !== exclude);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
    >
      <DialogContent className="sm:max-w-lg p-0 gap-0" data-testid="desk-problem-picker">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle>{t.pickTitle}</DialogTitle>
          <DialogDescription>{t.pickDescription}</DialogDescription>
        </DialogHeader>
        {notice && <div className="px-4 pb-2">{notice}</div>}
        <Command shouldFilter={false} className="border-t">
          <CommandInput placeholder={t.searchPlaceholder} value={query} onValueChange={setQuery} maxLength={200} />
          <CommandList className="max-h-72">
            {isFetching && results.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <InlineSpinner />
                {t.searching}
              </div>
            ) : (
              <CommandEmpty>{t.noResults}</CommandEmpty>
            )}
            {results.map((problem) => (
              <CommandItem
                key={problem.id}
                value={problem.id}
                disabled={disabled}
                onSelect={() => onPick(problem)}
                className="flex items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  #{problem.problemNumber} {problem.title}
                </span>
                <ProblemStatusBadge status={problem.status} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
