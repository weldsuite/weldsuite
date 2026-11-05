import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useProject, useProjects } from '@/hooks/queries/use-projects-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

export interface ProjectSelectProps {
  /** The WeldFlow project's id; null for none. */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * The WeldFlow project a cost line belongs to (FLOW-019): a bill or journal
 * line in WeldBooks, a purchase order line, an expense declaration. A search
 * box over the workspace's projects, with a "No project" row that clears the
 * tag. The projects the caller can't see are not listed; a tagged project
 * that falls outside the first page of the list is read on its own, so the
 * button always shows its name.
 */
export function ProjectSelect({ value, onChange, disabled, id, className }: Readonly<ProjectSelectProps>) {
  const { t } = useI18n();
  const tp = t.flowFinance.projectTag;
  const [open, setOpen] = useState(false);
  const projects = useProjects({ pageSize: 100 });

  const options = useMemo(
    () =>
      [...(projects.data?.data ?? [])]
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projects.data],
  );
  const listed = options.find((option) => option.id === value);
  // Only when the tagged project is not among the loaded ones.
  const tagged = useProject(value ?? '', !!value && !listed && !projects.isLoading);
  const label = listed?.name ?? tagged.data?.data?.name ?? (value ? value : null);

  const choose = (projectId: string | null) => {
    onChange(projectId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={tp.label}
          disabled={disabled}
          className={cn('w-full justify-between font-normal shadow-none', !label && 'text-muted-foreground', className)}
        >
          <span className="truncate">{label ?? tp.none}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={tp.searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{projects.isError ? tp.loadFailed : tp.empty}</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__none__" onSelect={() => choose(null)}>
                <Check className={cn('mr-2 h-4 w-4', value ? 'opacity-0' : 'opacity-100')} aria-hidden />
                <span className="truncate text-muted-foreground">{tp.none}</span>
              </CommandItem>
              {options.map((option) => (
                <CommandItem key={option.id} value={`${option.name} ${option.id}`} onSelect={() => choose(option.id)}>
                  <Check className={cn('mr-2 h-4 w-4', value === option.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="truncate">{option.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
