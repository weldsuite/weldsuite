import { useId, useState } from 'react';
import { Copy, KeyRound, RefreshCw } from 'lucide-react';
import {
  generatePassword,
  passwordStrength,
  type GeneratePasswordOptions,
  type PasswordStrength,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { fillNewPassword } from '../lib/actions';
import { chromePage, type ActiveTab } from '../lib/chrome-page';
import { t, type MessageKey } from '../lib/i18n';
import { blockedMessageKey } from '../lib/messages';
import type { Notify } from './hooks';
import { Button, cx } from './ui';

const STRENGTH: Record<PasswordStrength, { label: MessageKey; className: string }> = {
  weak: { label: 'strengthWeak', className: 'text-destructive' },
  fair: { label: 'strengthFair', className: 'text-warning' },
  strong: { label: 'strengthStrong', className: 'text-success' },
};

const CLASSES: Array<{ option: 'uppercase' | 'digits' | 'symbols'; label: MessageKey }> = [
  { option: 'uppercase', label: 'genUppercase' },
  { option: 'digits', label: 'genDigits' },
  { option: 'symbols', label: 'genSymbols' },
];

type Options = Required<GeneratePasswordOptions>;

export function Generator({ tab, notify }: { tab: ActiveTab | null; notify: Notify }) {
  const ids = useId();
  const [options, setOptions] = useState<Options>({
    length: 20,
    uppercase: true,
    digits: true,
    symbols: true,
  });
  // The generated password has to be on screen, so it lives in this component's
  // state — and nowhere else. It is gone when the popup closes.
  const [password, setPassword] = useState(() => generatePassword(options));
  const [filling, setFilling] = useState(false);

  function update(patch: Partial<Options>) {
    const next = { ...options, ...patch };
    setOptions(next);
    setPassword(generatePassword(next));
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      notify('ok', t('passwordCopied'));
    } catch {
      notify('error', t('copyFailed'));
    }
  }

  async function fillIntoPage() {
    if (!tab) {
      notify('error', t('fillNoPage'));
      return;
    }
    setFilling(true);
    const outcome = await fillNewPassword(chromePage, tab.id, password).finally(() =>
      setFilling(false),
    );
    if (outcome.ok) notify('ok', t('genFilled', outcome.fields));
    else if (outcome.reason === 'no-fields') notify('error', t('genNoFields'));
    else notify('error', t(blockedMessageKey(outcome.reason)));
  }

  const strength = STRENGTH[passwordStrength(password)];

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">{t('genPassword')}</span>
          <span>
            <span className="text-muted-foreground">{t('strengthLabel')}: </span>
            <span className={cx('font-medium', strength.className)}>{t(strength.label)}</span>
          </span>
        </div>
        <output
          aria-label={t('genPassword')}
          className="block select-all break-all rounded-md border bg-card px-2.5 py-2 font-mono text-[13px]"
        >
          {password}
        </output>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setPassword(generatePassword(options))}>
          <RefreshCw className="size-3.5" aria-hidden />
          {t('genRegenerate')}
        </Button>
        <Button onClick={copy} autoFocus>
          <Copy className="size-3.5" aria-hidden />
          {t('genCopy')}
        </Button>
        <Button variant="primary" onClick={fillIntoPage} disabled={filling}>
          <KeyRound className="size-3.5" aria-hidden />
          {t('genFill')}
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-length`} className="flex justify-between text-xs">
          <span className="font-medium text-muted-foreground">{t('genLength')}</span>
          <span className="tabular-nums">{options.length}</span>
        </label>
        <input
          id={`${ids}-length`}
          type="range"
          min={8}
          max={64}
          value={options.length}
          onChange={(event) => update({ length: Number(event.target.value) })}
          className="w-full accent-primary"
        />
      </div>

      <fieldset className="flex flex-col gap-1.5">
        {CLASSES.map(({ option, label }) => (
          <label key={option} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options[option]}
              onChange={(event) => update({ [option]: event.target.checked })}
              className="size-3.5 accent-primary"
            />
            {t(label)}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
