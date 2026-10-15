import type { ComponentType, ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@weldsuite/ui/components/sidebar';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAvatarColor } from '@/components/shared/conversation-list/utils';

export interface ScopeOption {
  id: string;
  name: string;
  /** Second line, e.g. "NL · EUR" or an email address. */
  description?: string;
  /** Shown in the rounded square instead of the name's initial. */
  icon?: ComponentType<{ className?: string }>;
  /** Names shown as a 2×2 grid of coloured squares (e.g. "All accounts"). */
  stack?: string[];
  /** Extra content at the end of the menu row (a badge, a default toggle). */
  trailing?: ReactNode;
}

interface SidebarScopeSwitcherProps {
  options: ScopeOption[];
  currentId: string | null | undefined;
  onSelect: (id: string) => void;
  /** Menu heading, e.g. "Legal entity". */
  label: string;
  /** Trigger text while nothing is selected. */
  placeholder: string;
  addLabel?: string;
  onAdd?: () => void;
}

/** Letter (or icon) on a colour picked from the name, like the conversation-list avatars. */
function ScopeAvatar({ option, size }: { option: ScopeOption; size: 'sm' | 'lg' }) {
  const Icon = option.icon;
  const radius = size === 'lg' ? '!rounded-[10px]' : '!rounded-[7px]';
  const stack = option.stack ?? [];
  if (stack.length > 0) {
    return (
      <span
        className={cn(
          'grid shrink-0 grid-cols-2 grid-rows-2 gap-px overflow-hidden',
          size === 'lg' ? 'h-7 w-7' : 'h-5 w-5',
          radius,
        )}
      >
        {Array.from({ length: 4 }, (_, i) => stack[i % stack.length]).map((name, i) => (
          <span
            key={i}
            className="flex items-center justify-center text-[8px] font-semibold text-white"
            style={{ backgroundColor: getAvatarColor(name) }}
          >
            {size === 'lg' ? name.trim().charAt(0).toUpperCase() : null}
          </span>
        ))}
      </span>
    );
  }
  return (
    <Avatar className={cn(size === 'lg' ? 'h-7 w-7' : 'h-5 w-5', radius)}>
      <AvatarFallback
        className={cn(
          radius,
          size === 'lg' ? 'text-xs' : 'text-[10px]',
          'font-semibold text-white',
        )}
        style={{ backgroundColor: getAvatarColor(option.name) }}
      >
        {Icon ? (
          <Icon className={size === 'lg' ? 'h-4 w-4' : 'h-3 w-3'} />
        ) : (
          option.name.trim().charAt(0).toUpperCase() || '?'
        )}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The scope a module works in (WeldBooks entity, WeldMail account), shown as
 * the first row of the module sidebar: the stock shadcn sidebar switcher.
 */
export function SidebarScopeSwitcher({
  options,
  currentId,
  onSelect,
  label,
  placeholder,
  addLabel,
  onAdd,
}: Readonly<SidebarScopeSwitcherProps>) {
  const current = options.find((o) => o.id === currentId);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {current ? <ScopeAvatar option={current} size="lg" /> : null}
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{current ? current.name : placeholder}</span>
                {current?.description ? (
                  <span className="truncate text-xs text-muted-foreground">{current.description}</span>
                ) : null}
              </div>
              <ChevronsUpDown className="ml-auto h-4 w-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={4}
            className="w-(--radix-dropdown-menu-trigger-width) min-w-[240px]"
          >
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onClick={() => onSelect(option.id)}>
                <div className="flex items-center gap-2 w-full">
                  <ScopeAvatar option={option} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{option.name}</div>
                    {option.description ? (
                      <div className="text-xs text-muted-foreground truncate">{option.description}</div>
                    ) : null}
                  </div>
                  {option.trailing}
                  {option.id === currentId ? <Check className="h-4 w-4 text-primary" /> : <span className="w-4" />}
                </div>
              </DropdownMenuItem>
            ))}
            {onAdd && addLabel ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onAdd}>
                  <Plus className="h-4 w-4 mr-2" />
                  {addLabel}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
