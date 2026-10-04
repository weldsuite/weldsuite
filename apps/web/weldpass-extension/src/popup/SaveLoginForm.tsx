import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { WeldPassPasswordsApi } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { hostOf, itemInputSchema } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { readLoginFromPage } from '../lib/actions';
import { chromePage, type ActiveTab } from '../lib/chrome-page';
import { errorMessageKey } from '../lib/errors';
import { t, type MessageKey } from '../lib/i18n';
import { pageUrlForSaving } from '../lib/urls';
import { useAsync, type Notify } from './hooks';
import { Button, IconButton, Notice, Spinner } from './ui';

interface Props {
  api: WeldPassPasswordsApi;
  tab: ActiveTab | null;
  notify: Notify;
  onSaved: () => void;
  onCancel: () => void;
}

const inputClass = 'h-8 w-full rounded-md border bg-card px-2 text-[13px]';

/**
 * "Save login for this site". Opening it reads what is typed in the page's
 * login form — the one moment the save flow touches the page. Those values are
 * page-controlled: they only ever land in React-rendered input values, which
 * are text, never markup.
 */
export function SaveLoginForm({ api, tab, notify, onSaved, onCancel }: Props) {
  const ids = useId();
  const vaults = useAsync(async () => (await api.listVaults()).data, 'vaults');
  // Only vaults the caller may add to; a viewer cannot.
  const writable = (vaults.data ?? []).filter(
    (vault) => vault.role === 'editor' || vault.role === 'manager',
  );

  const [title, setTitle] = useState(() => hostOf(tab?.url) ?? '');
  const [url, setUrl] = useState(() => pageUrlForSaving(tab?.url) ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [chosenVault, setChosenVault] = useState('');
  const [hint, setHint] = useState<MessageKey | null>(null);
  const [saving, setSaving] = useState(false);

  const vaultId =
    chosenVault || (writable.find((vault) => vault.kind === 'personal') ?? writable[0])?.id || '';

  useEffect(() => {
    if (!tab) {
      setHint('saveNoPage');
      return;
    }
    let current = true;
    void readLoginFromPage(chromePage, tab.id).then((read) => {
      if (!current) return;
      if (!read.ok) {
        setHint('saveNoPage');
      } else if (!read.username && !read.password) {
        setHint('saveReadNothing');
      } else {
        // Do not overwrite something the user has already started typing here.
        setUsername((value) => value || read.username);
        setPassword((value) => value || read.password);
        setHint('saveRead');
      }
    });
    return () => {
      current = false;
    };
  }, [tab]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = itemInputSchema.safeParse({
      type: 'login',
      title,
      url: url.trim() || null,
      fields: { username, password, totp: '', notes: '' },
    });
    if (!parsed.success || !vaultId) {
      notify('error', t('validationFailed'));
      return;
    }

    setSaving(true);
    try {
      await api.createItem(vaultId, parsed.data);
      notify('ok', t('saved'));
      onSaved();
    } catch (error) {
      notify('error', t(errorMessageKey(error)));
      setSaving(false);
    }
  }

  if (vaults.loading) {
    return (
      <div className="p-3">
        <Spinner label={t('loading')} />
      </div>
    );
  }
  if (vaults.error) {
    return (
      <div className="flex flex-col items-start gap-2 p-3">
        <Notice tone="error">{t(errorMessageKey(vaults.error))}</Notice>
        <Button onClick={vaults.reload}>{t('retry')}</Button>
      </div>
    );
  }
  if (writable.length === 0) {
    return (
      <div className="p-3">
        <Notice tone="warning">{t('noWritableVault')}</Notice>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 p-3">
      <h2 className="text-sm font-semibold">{t('saveForSite')}</h2>
      {hint && <Notice>{t(hint)}</Notice>}

      <Field id={`${ids}-title`} label={t('fieldTitle')}>
        <input
          id={`${ids}-title`}
          className={inputClass}
          value={title}
          maxLength={200}
          required
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field id={`${ids}-url`} label={t('fieldUrl')}>
        <input
          id={`${ids}-url`}
          className={inputClass}
          value={url}
          maxLength={2048}
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      <Field id={`${ids}-username`} label={t('fieldUsername')}>
        <input
          id={`${ids}-username`}
          className={inputClass}
          value={username}
          maxLength={255}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field id={`${ids}-password`} label={t('fieldPassword')}>
        <div className="flex gap-1">
          <input
            id={`${ids}-password`}
            className={`${inputClass} font-mono`}
            type={showPassword ? 'text' : 'password'}
            value={password}
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPassword(event.target.value)}
          />
          <IconButton
            label={showPassword ? t('hidePassword') : t('showPassword')}
            aria-pressed={showPassword}
            className="size-8"
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? (
              <EyeOff className="size-3.5" aria-hidden />
            ) : (
              <Eye className="size-3.5" aria-hidden />
            )}
          </IconButton>
        </div>
      </Field>
      <Field id={`${ids}-vault`} label={t('fieldVault')}>
        <select
          id={`${ids}-vault`}
          className={inputClass}
          value={vaultId}
          onChange={(event) => setChosenVault(event.target.value)}
        >
          {writable.map((vault) => (
            <option key={vault.id} value={vault.id}>
              {vault.kind === 'personal' ? t('personalVault') : vault.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="mt-1 flex justify-end gap-2">
        <Button onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
