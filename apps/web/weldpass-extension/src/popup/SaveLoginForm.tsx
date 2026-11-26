import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { hostOf, itemInputSchema } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { readLoginFromPage } from '../lib/actions';
import { chromePage, type ActiveTab } from '../lib/chrome-page';
import { errorMessageKey } from '../lib/errors';
import { t } from '../lib/i18n';
import { pageUrlForSaving } from '../lib/urls';
import type { PopupApi } from './api';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@weldsuite/ui/components/input-group';
import { Label } from '@weldsuite/ui/components/label';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useAsync, type Notify } from './hooks';
import { PopupAlert, vaultLabel } from './list';

interface Props {
  api: PopupApi;
  tab: ActiveTab | null;
  notify: Notify;
  onSaved: () => void;
  onCancel: () => void;
}

/** The popup's controls are one size: the library's small (32px) field. */
const FIELD = 'h-8 text-[13px]';

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
  const [saving, setSaving] = useState(false);

  const vaultId =
    chosenVault || (writable.find((vault) => vault.kind === 'personal') ?? writable[0])?.id || '';

  // Fill in what is typed in the page's login form, if anything.
  useEffect(() => {
    if (!tab) return;
    let current = true;
    void readLoginFromPage(chromePage, tab.id).then((read) => {
      if (!current || !read.ok) return;
      // Do not overwrite something the user has already started typing here.
      setUsername((value) => value || read.username);
      setPassword((value) => value || read.password);
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
        <InlineSpinner label={t('loading')} className="py-0" />
      </div>
    );
  }
  if (vaults.error) {
    return (
      <div className="flex flex-col items-start gap-2 p-3">
        <PopupAlert tone="error">{t(errorMessageKey(vaults.error))}</PopupAlert>
        <Button variant="outline" size="sm" onClick={vaults.reload}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (writable.length === 0) {
    return (
      <div className="p-3">
        <PopupAlert tone="warning">{t('noWritableVault')}</PopupAlert>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 p-3">

      <Field id={`${ids}-title`} label={t('fieldTitle')}>
        <Input
          id={`${ids}-title`}
          className={FIELD}
          value={title}
          maxLength={200}
          required
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field id={`${ids}-url`} label={t('fieldUrl')}>
        <Input
          id={`${ids}-url`}
          className={FIELD}
          value={url}
          maxLength={2048}
          spellCheck={false}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      <Field id={`${ids}-username`} label={t('fieldUsername')}>
        <Input
          id={`${ids}-username`}
          className={FIELD}
          value={username}
          maxLength={255}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field id={`${ids}-password`} label={t('fieldPassword')}>
        <InputGroup className="h-8">
          <InputGroupInput
            id={`${ids}-password`}
            className="h-7.5 py-0 font-mono text-[13px]"
            type={showPassword ? 'text' : 'password'}
            value={password}
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPassword(event.target.value)}
          />
          <InputGroupAddon align="inline-end" className="py-0">
            <InputGroupButton
              size="icon-xs"
              aria-label={showPassword ? t('hidePassword') : t('showPassword')}
              title={showPassword ? t('hidePassword') : t('showPassword')}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </Field>
      <Field id={`${ids}-vault`} label={t('fieldVault')}>
        <Select value={vaultId} onValueChange={setChosenVault}>
          <SelectTrigger id={`${ids}-vault`} size="sm" className={`w-full ${FIELD}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {writable.map((vault) => (
              <SelectItem key={vault.id} value={vault.id}>
                {vaultLabel(vault)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="mt-1 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button size="sm" type="submit" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
