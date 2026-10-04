import { useMemo, useRef, useState } from 'react';
import { useAuth } from '@clerk/chrome-extension';
import { createPasswordsApi } from '../lib/api';
import type { ExtensionConfig } from '../lib/config';
import { t, type MessageKey } from '../lib/i18n';
import { Generator } from './Generator';
import { useActiveTab, useStatus } from './hooks';
import { LoginsView } from './LoginsView';
import { SaveLoginForm } from './SaveLoginForm';
import { Brand, StatusBar, cx } from './ui';

type View = 'logins' | 'save' | 'generator';

const TABS: Array<{ view: View; label: MessageKey }> = [
  { view: 'logins', label: 'tabLogins' },
  { view: 'save', label: 'tabSave' },
  { view: 'generator', label: 'tabGenerator' },
];

export function Vault({ config }: { config: ExtensionConfig }) {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  // The token is asked for per request and never kept: Clerk hands out
  // short-lived session JWTs and refreshes them itself.
  const api = useMemo(
    () => createPasswordsApi({ apiUrl: config.apiUrl, getToken: () => getTokenRef.current() }),
    [config.apiUrl],
  );

  const tab = useActiveTab();
  const { status, notify } = useStatus();
  const [view, setView] = useState<View>('logins');
  /** Bumped after a save, so the lists reload. */
  const [revision, setRevision] = useState(0);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-3 py-2">
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
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {/* Kept mounted so the search text and the loaded list survive a tab switch. */}
        <div hidden={view !== 'logins'}>
          <LoginsView
            api={api}
            tab={tab}
            notify={notify}
            revision={revision}
            onSave={() => setView('save')}
          />
        </div>
        {view === 'save' && tab !== undefined && (
          <SaveLoginForm
            api={api}
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
