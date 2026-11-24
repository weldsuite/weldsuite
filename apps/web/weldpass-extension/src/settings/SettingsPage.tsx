/**
 * The extension's settings page (`settings.html`, also the options page),
 * opened in a tab rather than the popup: asking for host access shows a
 * browser prompt, which would close a popup and lose the answer.
 *
 * - Server: `https://app.weldsuite.eu` by default; "use your own server"
 *   asks for host access to that server, reads its `/config.json`, asks for
 *   access to its sign-in server too, and only then switches.
 * - Inline menus and save prompts on or off, and the sites where each never
 *   shows (hosts only).
 * - Account: who is signed in, and signing out.
 */

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { t, type MessageKey } from '../lib/i18n';
import { request } from '../lib/messaging';
import type { ExtensionState } from '../lib/protocol';
import { hostPatternsFor, normaliseServerAddress, serverLabel, type ServerProblem } from '../lib/server';
import { withoutHost, type Settings } from '../lib/settings';
import { useExtensionState } from '../popup/state';
import { Brand, Button, IconButton, Notice, Spinner } from '../popup/ui';

const SERVER_PROBLEM: Record<ServerProblem | 'no-permission', MessageKey> = {
  unreachable: 'serverUnreachable',
  'not-weldsuite': 'serverNotWeldSuite',
  'no-extension-sign-in': 'serverNoExtensionSignIn',
  'no-weldpass': 'serverNoWeldPass',
  'no-permission': 'serverNoPermission',
};

const ADDRESS_PROBLEM: Record<'empty' | 'invalid' | 'insecure', MessageKey> = {
  empty: 'serverAddressEmpty',
  invalid: 'serverAddressInvalid',
  insecure: 'serverAddressInsecure',
};

function Section({ id, title, children }: Readonly<{ id?: string; title: string; children: ReactNode }>) {
  return (
    <section id={id} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Switch({
  label,
  description,
  checked,
  onChange,
}: Readonly<{
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}>) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-describedby={`${id}-description`}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
    </div>
  );
}

function SiteList({ hosts, empty, onRemove }: Readonly<{ hosts: string[]; empty: string; onRemove: (host: string) => void }>) {
  if (hosts.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {hosts.map((host) => (
        <li key={host} className="flex items-center justify-between gap-2 px-2.5 py-1">
          <span className="truncate">{host}</span>
          <IconButton label={t('settingsRemoveSite', host)} onClick={() => onRemove(host)}>
            <Trash2 className="size-3.5" aria-hidden />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

/** Ask the browser for host access. Must run in the click that asks for it. */
async function grant(patterns: string[]): Promise<boolean> {
  if (patterns.length === 0) return true;
  try {
    return await chrome.permissions.request({ origins: patterns });
  } catch {
    return false;
  }
}

function ServerSection({ state, onState }: Readonly<{ state: ExtensionState; onState: (state: ExtensionState) => void }>) {
  const ids = useId();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  /** The issuer of a server whose sign-in host still needs access: a second click asks for it. */
  const [pending, setPending] = useState<{ origin: string; patterns: string[]; issuer: string } | null>(null);

  async function connect(origin: string) {
    const result = await request({ type: 'server:set', origin });
    if (result.ok) {
      onState(result.state);
      setPending(null);
      setAddress('');
    } else {
      setProblem(SERVER_PROBLEM[result.problem]);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setPending(null);
    const parsed = normaliseServerAddress(address);
    if (!parsed.ok) {
      setProblem(ADDRESS_PROBLEM[parsed.reason]);
      return;
    }
    setBusy(true);
    try {
      // First the server itself, so its /config.json can be read.
      if (!(await grant(hostPatternsFor([parsed.origin])))) {
        setProblem('serverNoPermission');
        return;
      }
      const inspected = await request({ type: 'server:inspect', origin: parsed.origin });
      if (!inspected.ok) {
        setProblem(SERVER_PROBLEM[inspected.problem]);
        return;
      }
      const missing = [];
      for (const pattern of inspected.patterns) {
        if (!(await chrome.permissions.contains({ origins: [pattern] }))) missing.push(pattern);
      }
      if (missing.length > 0) {
        // A new browser prompt needs a new click.
        setPending({ origin: parsed.origin, patterns: missing, issuer: inspected.issuer });
        return;
      }
      await connect(parsed.origin);
    } catch {
      setProblem('errorGeneric');
    } finally {
      setBusy(false);
    }
  }

  async function allowIssuer() {
    if (!pending) return;
    setBusy(true);
    try {
      if (await grant(pending.patterns)) await connect(pending.origin);
      else setProblem('serverNoPermission');
    } finally {
      setBusy(false);
    }
  }

  async function allowMissing() {
    setBusy(true);
    try {
      if (await grant(state.server.missingPatterns)) {
        const result = await request({ type: 'server:set', origin: state.server.isDefault ? null : state.server.origin });
        if (result.ok) onState(result.state);
        else setProblem(SERVER_PROBLEM[result.problem]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function backToDefault() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await request({ type: 'server:set', origin: null });
      if (result.ok) onState(result.state);
      else setProblem(SERVER_PROBLEM[result.problem]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="server" title={t('settingsServer')}>
      <p>
        {t('settingsServerCurrent', state.server.label)}
        {state.server.isDefault ? ` ${t('settingsServerDefault')}` : ''}
      </p>
      {state.server.problem && (
        <Notice tone={state.server.problem === 'no-permission' ? 'warning' : 'error'}>
          {t(SERVER_PROBLEM[state.server.problem])}
        </Notice>
      )}
      {state.server.problem === 'no-permission' && (
        <div>
          <Button variant="primary" disabled={busy} onClick={allowMissing}>
            {t('serverGrant')}
          </Button>
        </div>
      )}
      {!state.server.isDefault && (
        <div>
          <Button disabled={busy} onClick={backToDefault}>
            {t('settingsServerBack')}
          </Button>
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={`${ids}-address`} className="text-xs font-medium text-muted-foreground">
          {t('settingsServerOwn')}
        </label>
        <div className="flex gap-2">
          <input
            id={`${ids}-address`}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://weldsuite.example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px]"
          />
          <Button type="submit" variant="primary" disabled={busy} className="h-8">
            {t('settingsServerConnect')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settingsServerHelp')}</p>
      </form>

      {pending && (
        <Notice tone="warning">
          <span className="flex flex-col items-start gap-2">
            {t('settingsServerIssuer', serverLabel(pending.issuer))}
            <Button variant="primary" disabled={busy} onClick={allowIssuer}>
              {t('serverGrant')}
            </Button>
          </span>
        </Notice>
      )}
      {problem && <Notice tone="error">{t(problem)}</Notice>}
    </Section>
  );
}

function AccountSection({ state, onState }: Readonly<{ state: ExtensionState; onState: (state: ExtensionState) => void }>) {
  const [busy, setBusy] = useState(false);
  if (!state.person) {
    return (
      <Section title={t('settingsAccount')}>
        <p className="text-muted-foreground">{t('signedOutBody', state.server.label)}</p>
        <div>
          <Button
            variant="primary"
            disabled={busy || state.server.problem !== null}
            onClick={async () => {
              setBusy(true);
              await request({ type: 'auth:sign-in' }).catch(() => null);
              setBusy(false);
            }}
          >
            {busy ? t('signingIn') : t('signIn')}
          </Button>
        </div>
      </Section>
    );
  }
  const workspace = state.workspaces.find((entry) => entry.id === state.activeWorkspaceId);
  return (
    <Section title={t('settingsAccount')}>
      <p>{t('settingsSignedInAs', state.person.email ?? state.person.name ?? '—', state.server.label)}</p>
      {workspace && <p className="text-muted-foreground">{t('settingsWorkspace', workspace.name)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const next = await request({ type: 'auth:sign-out' }).catch(() => null);
            setBusy(false);
            if (next) onState(next);
          }}
        >
          {t('signOut')}
        </Button>
        {state.server.accountUrl && (
          <Button variant="ghost" onClick={() => void chrome.tabs.create({ url: state.server.accountUrl! })}>
            {t('settingsManageAccount')}
          </Button>
        )}
      </div>
    </Section>
  );
}

export function SettingsPage() {
  const { state, setState } = useExtensionState();
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    document.title = `${t('settingsTitle')} · WeldPass`;
    request({ type: 'settings:get' }).then(setSettings, () => setSettings(null));
  }, []);

  async function update(patch: Partial<Settings>) {
    const next = await request({ type: 'settings:set', patch }).catch(() => null);
    if (next) setSettings(next);
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between">
        <Brand />
        <h1 className="text-sm font-semibold text-muted-foreground">{t('settingsTitle')}</h1>
      </header>

      {(state === undefined || settings === null) && <Spinner label={t('loading')} />}
      {state === null && settings !== null && <Notice tone="error">{t('errorServer')}</Notice>}
      {state && settings && (
        <>
          <AccountSection state={state} onState={setState} />

          <Section title={t('settingsInline')}>
            <Switch
              label={t('settingsInlineMenus')}
              description={t('settingsInlineMenusHelp')}
              checked={settings.inlineMenus}
              onChange={(inlineMenus) => void update({ inlineMenus })}
            />
            <SiteList
              hosts={settings.neverMenuHosts}
              empty={t('settingsNoSites')}
              onRemove={(host) => void update({ neverMenuHosts: withoutHost(settings.neverMenuHosts, host) })}
            />
            <AddSite onAdd={(host) => void update({ neverMenuHosts: [...settings.neverMenuHosts, host] })} />
          </Section>

          <Section title={t('settingsSave')}>
            <Switch
              label={t('settingsSavePrompts')}
              description={t('settingsSavePromptsHelp')}
              checked={settings.savePrompts}
              onChange={(savePrompts) => void update({ savePrompts })}
            />
            <SiteList
              hosts={settings.neverSaveHosts}
              empty={t('settingsNoSites')}
              onRemove={(host) => void update({ neverSaveHosts: withoutHost(settings.neverSaveHosts, host) })}
            />
          </Section>

          <ServerSection state={state} onState={setState} />
        </>
      )}
    </div>
  );
}

function AddSite({ onAdd }: Readonly<{ onAdd: (host: string) => void }>) {
  const id = useId();
  const [value, setValue] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        onAdd(trimmed);
        setValue('');
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t('settingsAddSite')}
      </label>
      <input
        id={id}
        value={value}
        spellCheck={false}
        placeholder="example.com"
        onChange={(event) => setValue(event.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[13px]"
      />
      <Button type="submit" className="h-8">
        {t('settingsAddSite')}
      </Button>
    </form>
  );
}
