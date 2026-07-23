import { useState } from 'react';
import { MoreHorizontal, ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Link, usePathname } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { getModuleKey } from './module-sidebar-configs';
import {
  useAppChecklistItems,
  useDismissOnboardingChecklist,
  type AppChecklistItem,
} from '@/hooks/queries/use-onboarding-checklist';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Checkbox } from '@weldsuite/ui/components/checkbox';

function ChecklistItemRow({ item, label }: { item: AppChecklistItem; label: string }) {
  return (
    <Link
      href={item.href}
      className={`group flex items-center gap-2.5 px-2 py-[5.5px] rounded-[5px] text-[13px] transition-colors hover:bg-accent/60 ${
        item.completed ? 'text-muted-foreground' : 'text-foreground'
      }`}
    >
      <Checkbox
        checked={item.completed}
        tabIndex={-1}
        onClick={(e) => e.preventDefault()}
        className="pointer-events-none shrink-0 rounded-[5.5px]"
      />
      <span className={`flex-1 truncate ${item.completed ? 'line-through' : ''}`}>{label}</span>
    </Link>
  );
}

/**
 * Onboarding checklist rendered in the sidebar footer,
 * above the InviteMemberButton. Detects the current module
 * from the pathname and shows relevant tasks.
 * Hidden when the sidebar is collapsed.
 */
export function OnboardingChecklist({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const moduleKey = getModuleKey(pathname);
  const items = useAppChecklistItems(moduleKey);
  const dismiss = useDismissOnboardingChecklist();
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (collapsed || !items || !moduleKey) return null;

  const completedCount = items.filter((i) => i.completed).length;
  const percentage = items.length > 0 ? Math.round((completedCount / items.length) * 100) : 0;

  // Sort: incomplete first
  const sorted = [...items].sort((a, b) => {
    if (a.completed === b.completed) return 0;
    return a.completed ? 1 : -1;
  });

  return (
    <div className="mb-2">
      {isCollapsed ? (
        <Button
          variant="ghost"
          onClick={() => setIsCollapsed(false)}
          className="w-full group flex items-center gap-2 h-10 px-3 rounded-[9px] border border-border bg-background hover:bg-accent/60 transition-colors"
        >
          <span className="text-[13px] font-medium flex-1 text-left">
            {t.dashboard.onboardingChecklist.title}
          </span>
          <span className="text-[13px] font-mono tabular-nums text-muted-foreground">{percentage}%</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      ) : (
        <div className="rounded-[9px] border border-border bg-background p-1">
          {/* Header */}
          <div className="flex items-center justify-between px-2 pt-1.5 pb-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">
                {t.dashboard.onboardingChecklist.title}
              </span>
              <span className="text-[13px] font-mono tabular-nums text-muted-foreground">
                {completedCount}/{items.length}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-muted-foreground hover:text-foreground transition-all p-1 rounded-[4px] hover:rounded-[6px] hover:bg-accent h-auto w-auto">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem onClick={() => dismiss.mutate(moduleKey)}>
                    {t.dashboard.onboardingChecklist.dismiss}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                onClick={() => setIsCollapsed(true)}
                className="text-muted-foreground hover:text-foreground transition-all p-1 rounded-[4px] hover:rounded-[6px] hover:bg-accent h-auto w-auto"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Progress */}
          <div className="px-2 pb-3">
            <div className="h-[5px] rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-foreground transition-all duration-300"
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>

          {/* Task list */}
          <div className="flex flex-col">
            {sorted.map((item) => (
              <ChecklistItemRow
                key={item.key}
                item={item}
                label={(t.dashboard.onboardingChecklist.tasks as Record<string, string>)[item.key] || item.key}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
