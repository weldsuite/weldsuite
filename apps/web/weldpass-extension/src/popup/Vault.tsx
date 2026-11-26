import { useState, type ReactNode } from 'react';
import { Bell, Check, ChevronDown, Plus, Wrench } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { t, type MessageKey } from '../lib/i18n';
import { request } from '../lib/messaging';
import type { ExtensionState } from '../lib/protocol';
import { popupApi } from './api';
import { Generator } from './Generator';
import { useActiveTab, useAsync, useStatus } from './hooks';
import { PageHeader } from './list';
import { LoginsView } from './LoginsView';
import { AccountMenu } from './AccountMenu';
import { NotificationsView } from './Notifications';
import { SaveLoginForm } from './SaveLoginForm';
import { HealthView, ToolsList, type ToolView } from './Tools';
import { StatusBar } from './ui';

type View = 'logins' | 'save' | 'tools' | 'notifications' | ToolView;

/**
 * Logins is the home page. Every other page has a header with a chevron back:
 * to Logins, or (inside Tools) to the tools.
 */
const PAGES: Record<Exclude<View, 'logins'>, { title: MessageKey; back: 'logins' | 'tools' }> = {
  save: { title: 'saveForSite', back: 'logins' },
  tools: { title: 'toolsTitle', back: 'logins' },
  notifications: { title: 'notificationsTitle', back: 'logins' },
  generator: { title: 'toolGenerator', back: 'tools' },
  health: { title: 'toolHealth', back: 'tools' },
};

/** An icon button in the top bar (Save, Tools, Notifications), opening its page. */
function HeaderIcon({
  label,
  onClick,
  children,
}: Readonly<{ label: string; onClick: () => void; children: ReactNode }>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative size-7 shrink-0 text-muted-foreground hover:text-foreground"
    >
      {children}
    </Button>
  );
}

export function Vault({ state, onState }: Readonly<{ state: ExtensionState; onState: (state: ExtensionState) => void }>) {
  const tab = useActiveTab();
  const { status, notify } = useStatus();
  const [view, setView] = useState<View>('logins');
  /** Bumped after a save or a workspace switch, so the lists reload. */
  const [revision, setRevision] = useState(0);
  /** Bumped after marking notifications read, so the bell's count follows. */
  const [notificationsRevision, setNotificationsRevision] = useState(0);
  const notifications = useAsync(
    async () => (await popupApi.notifications()).data,
    `${revision}|${notificationsRevision}`,
  );
  const unread = notifications.data?.unread ?? 0;
  const activeWorkspace = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);

  async function markRead(id: string | null) {
    await (id ? popupApi.markNotificationRead(id) : popupApi.markAllNotificationsRead()).catch(() => null);
    setNotificationsRevision((value) => value + 1);
  }

  async function switchWorkspace(workspaceId: string) {
    const next = await request({ type: 'workspace:set', workspaceId }).catch(() => null);
    if (next) {
      onState(next);
      setRevision((value) => value + 1);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* The top bar is the home page's: every other page has only its own back header. */}
      {view === 'logins' && (
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {/* The workspace switch, where the logo was. Only with more than one workspace. */}
        {state.workspaces.length > 1 && (
          <div className="flex min-w-0 flex-1 items-center">
            {/* Not modal: its scroll lock pads and locks <body>, which in the popup is the whole window. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  data-workspace-switch=""
                  aria-label={t('workspaceCurrent', activeWorkspace?.name ?? '')}
                  className="h-7 min-w-0 max-w-44 justify-between gap-1.5 px-2 text-xs shadow-none"
                >
                  <span className="truncate">{activeWorkspace?.name}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56" aria-label={t('workspaceLabel')}>
                {/* As the platform's workspace switcher: the name, and a check on the right for the current one. */}
                {state.workspaces.map((workspace) => {
                  const current = workspace.id === state.activeWorkspaceId;
                  return (
                    <DropdownMenuItem
                      key={workspace.id}
                      aria-current={current ? 'true' : undefined}
                      onClick={() => {
                        if (!current) void switchWorkspace(workspace.id);
                      }}
                    >
                      <span className="flex-1 truncate">{workspace.name}</span>
                      {current && <Check className="h-4 w-4" aria-hidden />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
        <HeaderIcon label={t('saveForSite')} onClick={() => setView('save')}>
          <Plus className="size-4" />
        </HeaderIcon>
        <HeaderIcon label={t('toolsTitle')} onClick={() => setView('tools')}>
          <Wrench className="size-3.5" />
        </HeaderIcon>
        <HeaderIcon
          label={unread > 0 ? t('notificationsUnread', unread) : t('notificationsTitle')}
          onClick={() => setView('notifications')}
        >
          <Bell className="size-3.5" />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-background bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground tabular-nums"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </HeaderIcon>
        <AccountMenu state={state} onState={onState} />
        </div>
      </header>
      )}

      {view !== 'logins' && (
        <PageHeader
          title={t(PAGES[view].title)}
          backLabel={t(PAGES[view].back === 'logins' ? 'backToLogins' : 'toolsBack')}
          onBack={() => setView(PAGES[view].back)}
          count={view === 'notifications' ? unread : undefined}
          action={
            view === 'notifications' && unread > 0 ? (
              <Button variant="ghost" onClick={() => void markRead(null)} className="h-6 px-1.5 text-xs">
                {t('notificationsMarkAllRead')}
              </Button>
            ) : undefined
          }
        />
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        {/* Kept mounted so the search text and the loaded list survive a tab switch. */}
        <div hidden={view !== 'logins'}>
          <LoginsView
            api={popupApi}
            tab={tab}
            notify={notify}
            revision={revision}
            onSave={() => setView('save')}
          />
        </div>
        {view === 'save' && tab !== undefined && (
          <SaveLoginForm
            api={popupApi}
            tab={tab}
            notify={notify}
            onCancel={() => setView('logins')}
            onSaved={() => {
              setRevision((value) => value + 1);
              setView('logins');
            }}
          />
        )}
        {view === 'tools' && <ToolsList onOpen={setView} />}
        {view === 'notifications' && (
          <NotificationsView
            notifications={notifications}
            serverOrigin={state.server.origin}
            onRead={(row) => void markRead(row.id)}
          />
        )}
        {view === 'generator' && <Generator tab={tab ?? null} notify={notify} />}
        {view === 'health' && <HealthView api={popupApi} serverOrigin={state.server.origin} />}
      </main>

      <StatusBar status={status} />
    </div>
  );
}
