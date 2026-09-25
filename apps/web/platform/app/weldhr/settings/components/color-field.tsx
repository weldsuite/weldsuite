/** Colour swatch + hex text input, shared by settings and portal branding forms. */

import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';

const HEX_RE = /^#?[0-9a-fA-F]{3,8}$/;

function normalizeSwatch(value: string | null | undefined): string {
  if (!value) return '#94a3b8';
  const withHash = value.startsWith('#') ? value : `#${value}`;
  return HEX_RE.test(withHash) && withHash.length <= 7 ? withHash : '#94a3b8';
}

export function ColorField({
  id,
  label,
  value,
  onChange,
  placeholder,
  className,
}: Readonly<{
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}>) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={normalizeSwatch(value)}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? '#0d9488'}
          maxLength={20}
          className="font-mono"
        />
      </div>
    </div>
  );
}
