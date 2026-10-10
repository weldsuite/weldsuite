import * as React from 'react';
import { Check, ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Button } from '@weldsuite/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { ClearPickerItem, PickerCheck, PickerFooter, PickerScrollArea } from '@/components/shared/picker-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';


interface MemberSelectProps {
  value: string | undefined | null;
  onChange: (value: string) => void;
  allowClear?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /**
   * 'assignee' renders a Popover + Command picker that mirrors the task
   * detail panel's Assignees field one-to-one — same trigger layout,
   * rounded-[7px] colored avatar, search input, and clear-row.
   */
  variant?: 'default' | 'assignee';
  /**
   * 'assignee' variant inside a panel's field row: the member sits on the
   * value column's left edge with the smaller 18px avatar and no inline clear
   * button (clearing happens from the picker), as in the task panel.
   */
  panelRow?: boolean;
  /** 'assignee' variant: clicking the selected member calls this instead of opening the picker. */
  onOpenMember?: (userId: string) => void;
}
const ASSIGNEE_AVATAR_PALETTE = [
  '#0d9488',
  '#16a34a',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#0891b2',
  '#4f46e5',
];

function assigneeFallbackColor(seed: string): string {
  // An Int32Array slot wraps on every write, exactly like `| 0` did.
  const hash = new Int32Array(1);
  for (let i = 0; i < seed.length; i++) {
    hash[0] = Math.imul(hash[0]!, 31) + seed.codePointAt(i)!;
  }
  const idx = Math.abs(hash[0]!) % ASSIGNEE_AVATAR_PALETTE.length;
  return ASSIGNEE_AVATAR_PALETTE[idx]!;
}

interface AssigneeAvatarProps {
  id?: string;
  name?: string | null;
  picture?: string | null;
  className?: string;
}

function AssigneeAvatar({ id, name, picture, className }: Readonly<AssigneeAvatarProps>) {
  const seed = id || name || '?';
  const bg = assigneeFallbackColor(seed);
  const initial = (name || '?').charAt(0).toUpperCase();
  return (
    <Avatar className={cn('h-5 w-5 rounded-[7px]', className)}>
      {picture && <AvatarImage src={picture} className="rounded-[7px]" />}
      <AvatarFallback
        className="text-[10px] rounded-[7px] text-white font-medium"
        style={{ backgroundColor: bg }}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

export function MemberSelect({
  value,
  onChange,
  allowClear = true,
  disabled = false,
  className,
  placeholder = '--',
  variant = 'default',
  panelRow = false,
  onOpenMember,
}: Readonly<MemberSelectProps>) {
  const { getClient } = useAppApiClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['team-members', 'list'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: Array<{ userId: string; name: string | null; email?: string | null; picture?: string | null }> }>(
        '/team-members',
      );
    },
  });
  const members = data?.data ?? [];
  // Declared above the `assignee` early return below so the hook order stays
  // stable if `variant` changes on an already-mounted instance.
  const [open, setOpen] = React.useState(false);

  const selected = members.find((m) => m.userId === value);
  const selectedEmail = selected && 'email' in selected ? selected.email : null;
  const selectedLabel = selected
    ? selected.name?.trim() || selectedEmail || selected.userId
    : null;

  if (variant === 'assignee') {
    const selectedName = selected ? selected.name?.trim() || selectedEmail || selected.userId : '';
    const memberContent = selected ? (
      <>
        <AssigneeAvatar
          id={selected.userId}
          name={selectedName}
          picture={selected.picture}
          className={panelRow ? 'size-[18px]' : undefined}
        />
        <span
          className={cn(
            'text-sm text-gray-600 dark:text-muted-foreground truncate max-w-[150px]',
            onOpenMember && 'group-hover/member:underline',
          )}
        >
          {selectedLabel}
        </span>
      </>
    ) : null;

    return (
      <Popover>
        <div
          className={cn(
            'relative text-sm flex items-center justify-between gap-2 h-8 w-full group/field',
            // Panel rows sit on the value column's left edge; elsewhere (grid
            // cells) the field keeps its own inset.
            !panelRow && 'px-2',
            (disabled || isError) && 'pointer-events-none opacity-60',
            className,
          )}
        >
          {/* The popover trigger is a native button stretched over the field,
              so the controls below can sit above it without nesting
              interactive elements. */}
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled || isError}
              aria-label={selectedLabel ?? placeholder}
              className="absolute inset-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </PopoverTrigger>
          {selected ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                {onOpenMember ? (
                  // Clicking the member opens them; it sits above the trigger
                  // so the picker doesn't open as well.
                  <button
                    type="button"
                    onClick={() => onOpenMember(selected.userId)}
                    className="group/member relative z-[1] flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {memberContent}
                  </button>
                ) : (
                  memberContent
                )}
                {allowClear && !panelRow && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onChange('');
                    }}
                    className="relative z-[1] inline-flex items-center justify-center h-6 w-6 -ml-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover/field:opacity-100 focus-visible:opacity-100 transition-[opacity,color,background-color]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <span
                className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-[opacity,color,background-color] flex-shrink-0 opacity-0 group-hover/field:opacity-100"
                aria-label="Change"
              >
                <Plus className="h-4 w-4" />
              </span>
            </>
          ) : (
            <span className="text-muted-foreground group-hover/field:underline">
              {isLoading ? 'Loading…' : placeholder}
            </span>
          )}
        </div>
        {/* Stock shadcn Command list — same pieces as the task panel's pickers. */}
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search…" />
            <CommandList className="max-h-none overflow-visible">
              <PickerScrollArea>
                <CommandEmpty>No members found.</CommandEmpty>
                <CommandGroup>
                  {members.map((member) => {
                    const email = 'email' in member ? member.email : null;
                    const label = member.name?.trim() || email || member.userId;
                    const isSelected = member.userId === value;
                    return (
                      <CommandItem
                        key={member.userId}
                        value={label}
                        onSelect={() => onChange(isSelected ? '' : member.userId)}
                      >
                        <AssigneeAvatar id={member.userId} name={label} picture={member.picture} />
                        <span className="truncate">{label}</span>
                        <PickerCheck selected={isSelected} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </PickerScrollArea>
              {selected && allowClear && (
                <PickerFooter>
                  <ClearPickerItem label="Clear" onSelect={() => onChange('')} />
                </PickerFooter>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }

  const isDisabled = disabled || isError;

  return (
    <Popover open={open} onOpenChange={(o) => !isDisabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={isDisabled}
          className={cn(
            'border-input bg-transparent flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm shadow-none ring-offset-background placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          {selected ? (
            <div className="flex items-center gap-2 min-w-0">
              <AssigneeAvatar
                id={selected.userId}
                name={selected.name?.trim() || selectedEmail || selected.userId}
                picture={selected.picture}
              />
              <span className="truncate text-sm">{selectedLabel}</span>
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              {isLoading ? 'Loading…' : placeholder}
            </span>
          )}
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search members…" />
          <CommandList className="max-h-[260px] p-1">
            <CommandEmpty>No members found.</CommandEmpty>
            {members.map((member) => {
              const email = 'email' in member ? member.email : null;
              const label = member.name?.trim() || email || member.userId;
              const isSelected = member.userId === value;
              return (
                <CommandItem
                  key={member.userId}
                  value={`${label} ${email ?? ''}`}
                  onSelect={() => {
                    onChange(member.userId);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex items-center justify-between gap-2 px-1.5',
                    isSelected && 'bg-muted',
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <AssigneeAvatar
                      id={member.userId}
                      name={label}
                      picture={member.picture}
                    />
                    <span className="truncate">{label}</span>
                  </div>
                  {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </CommandItem>
              );
            })}
            <div className="h-px bg-border my-1" />
            <CommandItem
              value="__clear__"
              onSelect={() => {
                onChange('');
                setOpen(false);
              }}
              className="px-1.5 text-red-600 data-[selected=true]:text-red-600 data-[selected=true]:bg-red-50 dark:data-[selected=true]:bg-red-950"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-5 w-5 flex items-center justify-center shrink-0">
                  <Trash2 className="h-3.5 w-3.5 text-red-600" />
                </div>
                <span>Clear</span>
              </div>
            </CommandItem>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
