/** Password strength meter and the inline random-password generator. */

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { Slider } from '@weldsuite/ui/components/slider';
import {
  generatePassword,
  passwordStrength,
  type GeneratePasswordOptions,
  type PasswordStrength,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { cn } from '@/lib/utils';
import { usePasswordsT } from '../lib/use-passwords-t';

const STRENGTH_STYLE: Record<PasswordStrength, { filled: number; bar: string; text: string }> = {
  weak: { filled: 1, bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
  fair: { filled: 2, bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  strong: { filled: 3, bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
};

export function StrengthMeter({ password }: Readonly<{ password: string }>) {
  const tp = usePasswordsT();
  if (!password) return null;

  const strength = passwordStrength(password);
  const style = STRENGTH_STYLE[strength];

  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3].map((segment) => (
          <div
            key={segment}
            className={cn(
              'h-1 flex-1 rounded-full bg-muted',
              segment <= style.filled && style.bar,
            )}
          />
        ))}
      </div>
      <span className={cn('text-xs font-medium', style.text)}>{tp(`strength.${strength}`)}</span>
    </div>
  );
}

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

export function PasswordGenerator({
  onUse,
  onCancel,
}: Readonly<{ onUse: (password: string) => void; onCancel: () => void }>) {
  const tp = usePasswordsT();
  const [options, setOptions] = useState<Required<GeneratePasswordOptions>>({
    length: 20,
    uppercase: true,
    digits: true,
    symbols: true,
  });
  const [generated, setGenerated] = useState(() => generatePassword(options));

  /** Change an option and draw a fresh password with it. */
  function update(patch: Partial<Required<GeneratePasswordOptions>>) {
    const next = { ...options, ...patch };
    setOptions(next);
    setGenerated(generatePassword(next));
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 font-mono text-xs">
          {generated}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setGenerated(generatePassword(options))}
          aria-label={tp('generator.regenerate')}
          title={tp('generator.regenerate')}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <StrengthMeter password={generated} />

      <div className="space-y-1.5">
        <Label className="text-xs">{tp('generator.length', { count: options.length })}</Label>
        <Slider
          min={MIN_LENGTH}
          max={MAX_LENGTH}
          step={1}
          value={[options.length]}
          onValueChange={([length]) => update({ length })}
          aria-label={tp('generator.length', { count: options.length })}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={options.uppercase}
            onCheckedChange={(checked) => update({ uppercase: checked === true })}
          />
          {tp('generator.uppercase')}
        </label>
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={options.digits}
            onCheckedChange={(checked) => update({ digits: checked === true })}
          />
          {tp('generator.digits')}
        </label>
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={options.symbols}
            onCheckedChange={(checked) => update({ symbols: checked === true })}
          />
          {tp('generator.symbols')}
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {tp('common.cancel')}
        </Button>
        <Button type="button" size="sm" onClick={() => onUse(generated)}>
          {tp('generator.use')}
        </Button>
      </div>
    </div>
  );
}
