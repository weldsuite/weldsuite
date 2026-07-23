import { useState, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Badge } from '@weldsuite/ui/components/badge';
import { BookOpen, Globe, User, Users, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSearchCannedResponses, useUseCannedResponse } from '@/hooks/queries/use-helpdesk-queries';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';

interface CannedResponsePickerProps {
  /** Called with the rendered content and macro actions when a response is selected */
  onSelect: (result: {
    content: string;
    subject: string | null;
    actions: Array<{ type: string; value: unknown }>;
  }) => void;
  /** Variables to interpolate into the template */
  variables?: Record<string, unknown>;
  /** Additional class name for the trigger button */
  className?: string;
  disabled?: boolean;
}

const SCOPE_ICONS: Record<string, typeof Globe> = {
  global: Globe,
  team: Users,
  department: Building2,
  personal: User,
};

export function CannedResponsePicker({
  onSelect,
  variables = {},
  className,
  disabled,
}: CannedResponsePickerProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: searchResult } = useSearchCannedResponses(search || ' ');
  const useCannedResponse = useUseCannedResponse();

  const responses = searchResult?.data || [];

  // Group by category
  const grouped = responses.reduce<Record<string, typeof responses>>((acc, r) => {
    const cat = r.category || t('sweep.welddesk.cannedResponsePicker.uncategorized');
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});

  const handleSelect = useCallback(
    async (id: string) => {
      try {
        const result = await useCannedResponse.mutateAsync({ id, variables });
        const data = (result as any).data;
        if (data) {
          onSelect(data);
          setOpen(false);
          setSearch('');
        }
      } catch {
        toast.error(t('sweep.welddesk.cannedResponsePicker.failedToLoad'));
      }
    },
    [onSelect, variables, useCannedResponse],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          disabled={disabled}
          className={cn(
            'p-[7px] rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            'text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent',
            className,
          )}
          title={t('sweep.welddesk.cannedResponsePicker.savedRepliesTitle')}
        >
          <BookOpen className="h-[16px] w-[16px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" side="top">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('sweep.welddesk.cannedResponsePicker.searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{t('sweep.welddesk.cannedResponsePicker.noResultsFound')}</CommandEmpty>
            {Object.entries(grouped).map(([category, items]) => (
              <CommandGroup key={category} heading={category}>
                {items.map((item) => {
                  const ScopeIcon = SCOPE_ICONS[item.scope] || Globe;
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => handleSelect(item.id)}
                      className="flex items-center gap-2"
                    >
                      <ScopeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm truncate">{item.name}</span>
                          {item.shortcut && (
                            <Badge variant="secondary" className="text-[10px] px-1 py-0 font-mono shrink-0">
                              /{item.shortcut}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {item.content.slice(0, 80)}
                          {item.content.length > 80 ? '...' : ''}
                        </p>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
