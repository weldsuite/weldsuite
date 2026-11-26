/**
 * The signed-in person's avatar in the popup header, opening their menu:
 * Settings, the web app, their account, Sign out. The platform's profile
 * avatar (`SidebarUserMenu` in @weldsuite/ui, collapsed), composed from the
 * same Avatar and DropdownMenu, because that component's labels are English
 * only and its ⌘, hint has no meaning here.
 */

import { LogOut, Settings, UserRound } from 'lucide-react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { openTab } from '../lib/chrome-page';
import { SquareArrowUpRightExit } from '../lib/icons';
import { t } from '../lib/i18n';
import { request } from '../lib/messaging';
import type { ExtensionState } from '../lib/protocol';
import { openPage } from './state';

/** Up to two initials, from the name, else the email address. */
function initials(person: NonNullable<ExtensionState['person']>): string {
  const name = person.name?.trim();
  if (name) {
    return name
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return (person.email?.[0] ?? '?').toUpperCase();
}

export function AccountMenu({
  state,
  onState,
}: Readonly<{ state: ExtensionState; onState: (state: ExtensionState) => void }>) {
  const person = state.person;
  if (!person) return null;
  const accountUrl = state.server.accountUrl;

  async function signOut() {
    const next = await request({ type: 'auth:sign-out' }).catch(() => null);
    if (next) onState(next);
  }

  return (
    // Not modal: its scroll lock pads and locks <body>, which in the popup is the whole window.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 w-7 shrink-0 rounded-full p-0"
          aria-label={t('settingsAccount')}
          title={person.name ?? person.email ?? t('settingsAccount')}
        >
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-[10px] font-medium">{initials(person)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            {person.name && <p className="truncate text-sm font-medium leading-none">{person.name}</p>}
            {person.email && (
              <p className="truncate text-xs leading-none text-muted-foreground">{person.email}</p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openPage('settings.html')}>
          <Settings className="h-4 w-4" />
          <span>{t('settingsTitle')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openTab(state.server.origin)}>
          <SquareArrowUpRightExit className="h-4 w-4" />
          <span>{t('openWebApp')}</span>
        </DropdownMenuItem>
        {accountUrl && (
          <DropdownMenuItem onClick={() => openTab(accountUrl)}>
            <UserRound className="h-4 w-4" />
            <span>{t('settingsManageAccount')}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOut className="h-4 w-4" />
          <span>{t('signOut')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
