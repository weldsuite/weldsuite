/**
 * A chart's colour: the stock input group, its hex code with a square of the
 * colour in front. The square opens a picker (a colour field, a hue slider and
 * the theme's chart colours); the code can be typed. A theme colour is kept as
 * its variable, so it follows light and dark mode; a picked or typed one as
 * `#rrggbb`.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ColorPicker, ColorPickerHue, ColorPickerSelection } from '@weldsuite/ui/components/color-picker';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@weldsuite/ui/components/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import { CHART_COLORS, HEX_COLOR } from './custom-charts';

/** A faint inner edge, so a white or black colour still shows against the page. */
const EDGE = 'inset-ring inset-ring-black/10 dark:inset-ring-white/15';

/** `#rrggbb` for any CSS colour, theme variables included, as the browser paints it. */
function toHex(color: string): string {
  if (HEX_COLOR.test(color)) return color.toLowerCase();
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.appendChild(probe);
  const painted = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return '#000000';
  context.fillStyle = painted;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

export function ChartColorField({
  id,
  value,
  onChange,
}: Readonly<{ id: string; value: string; onChange: (color: string) => void }>) {
  const { t } = useI18n();
  const tb = t.accounting.dashboard.builder;
  const hex = useMemo(() => toHex(value), [value]);
  /** What is in the box while typing; `null` shows the colour's own code. */
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <InputGroup>
      <InputGroupAddon>
        <Popover>
          <PopoverTrigger asChild>
            <InputGroupButton size="icon-xs" aria-label={tb.pickColor}>
              <span aria-hidden className={`size-4 rounded-[4px] ${EDGE}`} style={{ backgroundColor: value }} />
            </InputGroupButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <ColorPickerBody value={value} hex={hex} onChange={onChange} />
          </PopoverContent>
        </Popover>
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        value={draft ?? hex}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const typed = e.target.value.trim();
          setDraft(typed);
          const full = typed.startsWith('#') ? typed : `#${typed}`;
          if (HEX_COLOR.test(full)) onChange(full.toLowerCase());
        }}
        onBlur={() => setDraft(null)}
      />
    </InputGroup>
  );
}

/** The picker's colour field and hue slider, then the theme colours. */
function ColorPickerBody({
  value,
  hex,
  onChange,
}: Readonly<{ value: string; hex: string; onChange: (color: string) => void }>) {
  const { t } = useI18n();
  const tb = t.accounting.dashboard.builder;
  // The picker only takes a starting colour: choosing a theme colour restarts it there.
  const [seed, setSeed] = useState({ key: 0, color: hex });
  // It reports its colour from an effect, once on mount (the colour it was given)
  // and again whenever its callback changes, so the callback is stable and skips
  // the mount report.
  const mounting = useRef(true);
  const latest = useRef({ hex, onChange });
  useLayoutEffect(() => {
    latest.current = { hex, onChange };
  });
  const fromPicker = useCallback((rgba: unknown) => {
    if (!Array.isArray(rgba)) return;
    if (mounting.current) {
      mounting.current = false;
      return;
    }
    const next = `#${rgba
      .slice(0, 3)
      .map((n: number) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')}`;
    if (next !== latest.current.hex) latest.current.onChange(next);
  }, []);

  const pickTheme = (color: string) => {
    onChange(color);
    mounting.current = true;
    setSeed((s) => ({ key: s.key + 1, color: toHex(color) }));
  };

  return (
    <div className="space-y-4">
      <ColorPicker key={seed.key} defaultValue={seed.color} onChange={fromPicker as never} className="h-auto gap-3">
        <ColorPickerSelection className="h-32 rounded-md" />
        <ColorPickerHue />
      </ColorPicker>
      <div role="radiogroup" aria-label={tb.themeColors} className="flex gap-3 p-1">
        {CHART_COLORS.map((color, index) => {
          const selected = value === color;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={tb.colorOption.replace('{n}', String(index + 1))}
              onClick={() => pickTheme(color)}
              style={{ backgroundColor: color }}
              className={`size-6 rounded-[4px] ring-offset-2 ring-offset-popover outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring ${EDGE} ${
                selected ? 'ring-2 ring-foreground' : 'hover:ring-2 hover:ring-border'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}
