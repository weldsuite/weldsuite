/**
 * Edits one theme's tokens: font, colours, background image with overlay, logo,
 * corner radius, alignment and text size. Controlled; the Design tab and the
 * workspace themes library both use it.
 */

import { useState } from 'react';
import type { FormThemeTokens } from '@weldsuite/forms-engine';
import { FormField } from '@weldsuite/ui/components/form-field';
import { Input } from '@weldsuite/ui/components/input';
import { Slider } from '@weldsuite/ui/components/slider';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import { normalizeHex } from '../lib/theme-presets';
import { ImageUrlField } from './media-fields';
import { OptionSelect } from './prop-controls';

type ColorKey = keyof FormThemeTokens['colors'];
const COLOR_KEYS: readonly ColorKey[] = ['background', 'question', 'answer', 'button', 'buttonText'];

function ColorField({ label, value, onChange, disabled }: Readonly<{ label: string; value: string; onChange: (hex: string) => void; disabled?: boolean }>) {
  const [text, setText] = useState<string | null>(null);
  return (
    <FormField label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={label}
          className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-not-allowed"
        />
        <Input
          value={text ?? value}
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex) onChange(hex);
          }}
          onBlur={() => setText(null)}
          disabled={disabled}
          maxLength={7}
          aria-label={`${label} (hex)`}
          className="font-mono text-xs"
        />
      </div>
    </FormField>
  );
}

interface Props {
  tokens: FormThemeTokens;
  onChange: (tokens: FormThemeTokens) => void;
  disabled?: boolean;
}

export function ThemeTokensEditor({ tokens, onChange, disabled }: Readonly<Props>) {
  const { t } = useI18n();
  const td = t.weldforms.design;

  return (
    <div className="space-y-4">
      <OptionSelect
        label={td.font}
        value={tokens.font}
        disabled={disabled}
        options={(['inter', 'system', 'serif', 'mono', 'rounded', 'grotesk'] as const).map((font) => ({ value: font, label: td.fonts[font] }))}
        onChange={(font) => onChange({ ...tokens, font })}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {COLOR_KEYS.map((key) => (
          <ColorField key={key} label={td.colors[key]} value={tokens.colors[key]} disabled={disabled} onChange={(hex) => onChange({ ...tokens, colors: { ...tokens.colors, [key]: hex } })} />
        ))}
      </div>

      <ImageUrlField label={td.backgroundImage} value={tokens.background.imageUrl} disabled={disabled} onChange={(imageUrl) => onChange({ ...tokens, background: { ...tokens.background, imageUrl } })} />
      {tokens.background.imageUrl && (
        <FormField label={`${td.overlay}: ${tokens.background.overlay}%`}>
          <Slider min={0} max={100} step={5} value={[tokens.background.overlay]} disabled={disabled} onValueChange={([overlay]) => onChange({ ...tokens, background: { ...tokens.background, overlay: overlay ?? 0 } })} aria-label={td.overlay} />
        </FormField>
      )}

      <ImageUrlField label={td.logo} value={tokens.logoUrl} disabled={disabled} onChange={(logoUrl) => onChange({ ...tokens, logoUrl })} />

      <OptionSelect
        label={td.radius}
        value={tokens.radius}
        disabled={disabled}
        options={(['none', 'small', 'medium', 'large', 'full'] as const).map((radius) => ({ value: radius, label: td.radii[radius] }))}
        onChange={(radius) => onChange({ ...tokens, radius })}
      />

      <FormField label={td.alignment}>
        <ToggleGroup type="single" size="sm" variant="outline" value={tokens.alignment} onValueChange={(v) => v && onChange({ ...tokens, alignment: v as FormThemeTokens['alignment'] })} disabled={disabled}>
          <ToggleGroupItem value="left">{td.alignLeft}</ToggleGroupItem>
          <ToggleGroupItem value="center">{td.alignCenter}</ToggleGroupItem>
        </ToggleGroup>
      </FormField>

      <FormField label={td.fontSize}>
        <ToggleGroup type="single" size="sm" variant="outline" value={tokens.fontSize} onValueChange={(v) => v && onChange({ ...tokens, fontSize: v as FormThemeTokens['fontSize'] })} disabled={disabled}>
          <ToggleGroupItem value="small">{td.sizeSmall}</ToggleGroupItem>
          <ToggleGroupItem value="medium">{td.sizeMedium}</ToggleGroupItem>
          <ToggleGroupItem value="large">{td.sizeLarge}</ToggleGroupItem>
        </ToggleGroup>
      </FormField>
    </div>
  );
}

/** A small colour strip showing a theme's look, for pickers. */
export function ThemeSwatch({ tokens, className }: Readonly<{ tokens: FormThemeTokens; className?: string }>) {
  return (
    <span className={className ?? 'inline-flex h-6 w-14 overflow-hidden rounded border'} aria-hidden>
      <span className="flex-1" style={{ background: tokens.colors.background }} />
      <span className="flex-1" style={{ background: tokens.colors.question }} />
      <span className="flex-1" style={{ background: tokens.colors.button }} />
    </span>
  );
}
