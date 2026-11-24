import { useId, useState } from 'react';
import { Settings } from 'lucide-react';
import { t, type MessageKey } from '../lib/i18n';
import { request } from '../lib/messaging';
import type { ExtensionState } from '../lib/protocol';
import { popupApi } from './api';
import { Generator } from './Generator';
import { useActiveTab, useStatus } from './hooks';
import { LoginsView } from './LoginsView';
import { SaveLoginForm } from './SaveLoginForm';
import { openPage } from './state';
import { Brand, IconButton, StatusBar, cx } from './ui';

type View = 'logins' | 'save' | 'generator';

const TABS: Array<{ view: View; label: MessageKey }> = [
  { view: 'logins', label: 'tabLogins' },
  { view: 'save', label: 'tabSave' },
  { view: 'generator', label: 'tabGenerator' },
];

export function Vault({ state, onState }: Readonly<{ state: ExtensionState; onState: (state: ExtensionState) => void }>) {
  const ids = useId();
  const tab = useActiveTab();
  const { status, notify } = useStatus();
  const [view, setView] = useState<View>('logins');
  /** Bumped after a save or a workspace switch, so the lists reload. */
  const [revision, setRevision] = useState(0);

  async function switchWorkspace(workspaceId: string) {
    const next = await request({ type: 'workspace:set', workspaceId }).catch(() => null);
    if (next) {
      onState(next);
      setRevision((value) => value + 1);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <Brand />
        <nav className="flex gap-0.5" aria-label="WeldPass">
          {TABS.map(({ view: target, label }) => (
            <button
              key={target}
              type="button"
              aria-current={view === target ? 'page' : undefined}
              onClick={() => setView(target)}
              className={cx(
                'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                view === target
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {t(label)}
            </button>
          ))}
          <IconButton label={t('settingsTitle')} onClick={() => openPage('settings.html')}>
            <Settings className="size-3.5" aria-hidden />
          </IconButton>
        </nav>
      </header>

      {state.workspaces.length > 1 && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
          <label htmlFor={`${ids}-workspace`} className="text-muted-foreground">
            {t('workspaceLabel')}
          </label>
          <select
            id={`${ids}-workspace`}
            value={state.activeWorkspaceId ?? ''}
            onChange={(event) => void switchWorkspace(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border bg-card px-1.5 text-xs"
          >
            {state.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </div>
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
        {view === 'generator' && <Generator tab={tab ?? null} notify={notify} />}
      </main>

      <StatusBar status={status} />
    </div>
  );
}
