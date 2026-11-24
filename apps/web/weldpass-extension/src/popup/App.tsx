import { useState } from 'react';
import { Settings } from 'lucide-react';
import { openTab } from '../lib/chrome-page';
import { t, type MessageKey } from '../lib/i18n';
import { request } from '../lib/messaging';
import type { ExtensionState, SignInResult } from '../lib/protocol';
import { openPage, useExtensionState } from './state';
import { Button, Screen, Spinner } from './ui';
import { Vault } from './Vault';

const PROBLEM: Record<NonNullable<ExtensionState['server']['problem']>, MessageKey> = {
  unreachable: 'serverUnreachable',
  'not-weldsuite': 'serverNotWeldSuite',
  'no-extension-sign-in': 'serverNoExtensionSignIn',
  'no-weldpass': 'serverNoWeldPass',
  'no-permission': 'serverNoPermission',
};

const SIGN_IN_FAILED: Record<Exclude<SignInResult, { ok: true }>['reason'], MessageKey | null> = {
  cancelled: null,
  unreachable: 'signInUnreachable',
  failed: 'signInFailed',
  server: 'serverUnreachable',
};

function OtherServer() {
  return (
    <Button variant="ghost" onClick={() => openPage('settings.html#server')}>
      <Settings className="size-3.5" aria-hidden />
      {t('serverChange')}
    </Button>
  );
}

function SignedOut({ state }: Readonly<{ state: ExtensionState }>) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);

  async function signIn() {
    setBusy(true);
    setFailure(null);
    // The worker runs the sign-in window; this popup usually closes when it opens.
    const result = await request({ type: 'auth:sign-in' }).catch(
      (): SignInResult => ({ ok: false, reason: 'failed' }),
    );
    setBusy(false);
    if (!result.ok) setFailure(SIGN_IN_FAILED[result.reason]);
  }

  return (
    <Screen
      title={t('signedOutTitle')}
      body={
        <div className="flex flex-col gap-2">
          <p>{t('signedOutBody', state.server.label)}</p>
          {failure && <p className="text-destructive">{t(failure)}</p>}
        </div>
      }
      action={
        <div className="flex flex-col items-center gap-2">
          <Button variant="primary" autoFocus disabled={busy} onClick={signIn}>
            {busy ? t('signingIn') : t('signIn')}
          </Button>
          <OtherServer />
        </div>
      }
    />
  );
}

function WorkspacePicker({ state, onChosen }: Readonly<{ state: ExtensionState; onChosen: (state: ExtensionState) => void }>) {
  const [busy, setBusy] = useState(false);
  return (
    <Screen
      title={t('pickWorkspaceTitle')}
      body={
        <ul className="flex w-64 flex-col gap-1 text-left">
          {state.workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Button
                className="w-full justify-start"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const next = await request({ type: 'workspace:set', workspaceId: workspace.id }).catch(() => null);
                  setBusy(false);
                  if (next) onChosen(next);
                }}
              >
                {workspace.name}
              </Button>
            </li>
          ))}
        </ul>
      }
    />
  );
}

export function App() {
  const { state, reload, setState } = useExtensionState();

  if (state === undefined) return <Screen title="WeldPass" body={<Spinner label={t('loading')} />} />;
  if (state === null) {
    return (
      <Screen title={t('authFailedTitle')} body={t('errorServer')} action={<Button onClick={reload}>{t('retry')}</Button>} />
    );
  }

  const { server } = state;
  if (server.problem) {
    return (
      <Screen
        title={server.label}
        body={t(PROBLEM[server.problem])}
        action={
          <div className="flex flex-col items-center gap-2">
            {server.problem === 'no-permission' ? (
              <Button variant="primary" autoFocus onClick={() => openPage('settings.html#server')}>
                {t('serverGrant')}
              </Button>
            ) : (
              <Button autoFocus onClick={reload}>
                {t('retry')}
              </Button>
            )}
            <OtherServer />
          </div>
        }
      />
    );
  }
  if (!state.loaded) return <Screen title="WeldPass" body={<Spinner label={t('loading')} />} />;
  if (!state.person) return <SignedOut state={state} />;
  if (!state.activeWorkspaceId && state.loadingWorkspaces) {
    return <Screen title="WeldPass" body={<Spinner label={t('loadingWorkspaces')} />} />;
  }
  if (state.workspaces.length === 0) {
    return (
      <Screen
        title={t('noWorkspaceTitle')}
        body={t('noWorkspaceBody')}
        action={
          <Button variant="primary" autoFocus onClick={() => openTab(server.origin)}>
            {t('openWebApp')}
          </Button>
        }
      />
    );
  }
  if (!state.activeWorkspaceId) return <WorkspacePicker state={state} onChosen={setState} />;
  return <Vault state={state} onState={setState} />;
}
