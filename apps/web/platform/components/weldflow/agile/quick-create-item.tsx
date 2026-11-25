/**
 * The quick-create row of a backlog section and of the epic page: a type
 * button and a title. A leading `/bug`, `/epic`, `/task`, `/spike` (or `/story`,
 * `/pbi`, `/feature`) sets the type; Enter adds the item and keeps the row
 * ready for the next one. Without a prefix the item is the chosen type, a
 * story (PBI) by default.
 */

import { useId, useState, type FormEvent } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { ItemType, ItemTypeNaming } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { parseQuickCreate } from '@/app/weldflow/lib/item-types';
import { TaskTypeBadge, useItemTypeLabel } from './task-type-badge';

export interface QuickCreateItemProps {
  /** The types the project offers for a new item. */
  types: readonly ItemType[];
  naming: ItemTypeNaming;
  featureLevel: boolean;
  placeholder: string;
  /** Resolves once the item exists; the row clears then. A rejection keeps the text. */
  onCreate: (input: { title: string; type: ItemType }) => Promise<void>;
  /** The type a new item gets without a prefix or a choice; default story, else the first offered. */
  defaultType?: ItemType;
}

export function QuickCreateItem({ types, naming, featureLevel, placeholder, onCreate, defaultType = 'story' }: Readonly<QuickCreateItemProps>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileBacklog.quick;
  const label = useItemTypeLabel();
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<ItemType | null>(null);
  const [busy, setBusy] = useState(false);

  const fallback: ItemType = types.includes(defaultType) ? defaultType : (types[0] ?? 'task');
  const selected = chosen && types.includes(chosen) ? chosen : fallback;
  const parsed = parseQuickCreate(text);
  const prefixed = parsed.type !== null && types.includes(parsed.type);
  const type = prefixed && parsed.type ? parsed.type : selected;
  const title = prefixed ? parsed.title : text.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title || busy) return;
    setBusy(true);
    try {
      await onCreate({ title, type });
      setText('');
    } catch {
      // The caller showed why; the text stays so it can be sent again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 md:px-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2"
            aria-label={format(copy.typeButton, { type: label(type, naming) })}
          >
            <TaskTypeBadge type={type} naming={naming} featureLevel={featureLevel} />
            <span className="text-sm">{label(type, naming)}</span>
            <ChevronDown aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {types.map((option) => (
            <DropdownMenuItem key={option} onSelect={() => setChosen(option)}>
              <TaskTypeBadge type={option} naming={naming} featureLevel size="sm" />
              {label(option, naming)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <label htmlFor={inputId} className="sr-only">
        {copy.label}
      </label>
      <div className="flex min-w-[200px] flex-1 items-center gap-2">
        <Plus aria-hidden className="h-4 w-4 flex-none text-muted-foreground" />
        <Input
          id={inputId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          aria-describedby={hintId}
          autoComplete="off"
          enterKeyHint="done"
          disabled={busy}
          className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
      <p id={hintId} className="w-full text-xs text-muted-foreground md:w-auto">
        {prefixed ? format(copy.willBeAdded, { type: label(type, naming) }) : copy.hint}
      </p>
      <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!title || busy}>
        {copy.add}
      </Button>
    </form>
  );
}
