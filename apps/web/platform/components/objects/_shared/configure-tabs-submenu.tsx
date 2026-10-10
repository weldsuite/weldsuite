/**
 * `ConfigureTabsSubmenu` — the "Configure tabs" entry of an object panel's
 * "More actions" (kebab) menu: a checkbox per tab plus a reset-to-defaults
 * item. Shared by the company and person panels so both menus offer the same
 * thing; the visibility state itself lives in `useObjectPanelTabConfig`.
 */

import { RotateCcw, Settings2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
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
      {/* The shared sub-trigger lacks the stock shadcn gap and icon styling
          that menu items have, so it is supplied here. */}
      <DropdownMenuSubTrigger className="gap-2 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:shrink-0">
        <Settings2 />
        {st('sweep.entities.configureTabs')}
      </DropdownMenuSubTrigger>
      {/* Stock shadcn submenu: default width, checkbox items, and reset as a
          plain item under a separator. */}
      <DropdownMenuSubContent>
        <DropdownMenuLabel>{st('sweep.entities.visibleTabs')}</DropdownMenuLabel>
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
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onResetTabs();
          }}
        >
          <RotateCcw />
          {st('sweep.entities.resetToDefaults')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
