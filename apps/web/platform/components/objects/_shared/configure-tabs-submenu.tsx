/**
 * `ConfigureTabsSubmenu` — the "Configure tabs" entry of an object panel's
 * "More actions" (kebab) menu: a checkbox per tab plus a reset-to-defaults
 * button. Shared by the company and person panels so both menus offer the same
 * thing; the visibility state itself lives in `useObjectPanelTabConfig`.
 */

import { RotateCcw, Settings2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@weldsuite/ui/components/dropdown-menu';

export interface ConfigurableTab {
  id: string;
  label: string;
  /** Required tabs are always shown and can't be switched off. */
  required?: boolean;
}

interface ConfigureTabsSubmenuProps {
  tabs: ConfigurableTab[];
  isTabVisible: (id: string) => boolean;
  onToggleTab: (id: string) => void;
  onResetTabs: () => void;
}

export function ConfigureTabsSubmenu({
  tabs,
  isTabVisible,
  onToggleTab,
  onResetTabs,
}: Readonly<ConfigureTabsSubmenuProps>) {
  const st = useTranslations();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Settings2 className="h-4 w-4 mr-0.5" />
        {st('sweep.entities.configureTabs')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>{st('sweep.entities.visibleTabs')}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.preventDefault();
              onResetTabs();
            }}
            className="p-1 -mr-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
            title={st('sweep.entities.resetToDefaults')}
            aria-label={st('sweep.entities.resetToDefaults')}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tabs.map((tab) => {
          const isOn = tab.required || isTabVisible(tab.id);
          return (
            <DropdownMenuCheckboxItem
              key={tab.id}
              checked={isOn}
              disabled={tab.required}
              onCheckedChange={() => onToggleTab(tab.id)}
              onSelect={(e) => e.preventDefault()}
            >
              {tab.label}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
