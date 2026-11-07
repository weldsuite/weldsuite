import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Pipette, Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ColorPicker, ColorPickerHue, ColorPickerSelection } from '@weldsuite/ui/components/color-picker';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverAnchor, PopoverContent } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

/** The colours a person saved in the colour pickers, newest first, and how to change them. */
export interface SavedColors {
  colors: readonly string[];
  onChange: (colors: string[]) => void;
}

/** Provided by the board editor; without it, a custom colour is used once and not kept. */
export const SavedColorsContext = createContext<SavedColors | null>(null);

/** Two rows of the grid, with the add button. */
const MAX_SAVED_COLORS = 15;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const SWATCH = 'size-6 rounded-sm border shadow-sm transition hover:scale-110';
const SELECTED = 'ring-2 ring-primary ring-offset-1';
/** "No colour": crossed out with a red line. */
const NONE = 'bg-[linear-gradient(135deg,transparent_45%,#ef4444_45%,#ef4444_55%,transparent_55%)]';

/** "No colour" in a list: `null`, or `transparent` for a fill or a line. */
function isNone(color: string | null): boolean {
  return !color || color === 'transparent';
}

/**
 * A colour swatch grid. `null` in the list is "none". Below it, the
 * person's saved colours and a button to make a new one.
 */
export function Swatches({
  colors,
  value,
  onPick,
  noneLabel,
  custom = true,
}: {
  colors: readonly (string | null)[];
  value: string | undefined;
  onPick: (color: string | null) => void;
  noneLabel?: string;
  /** Show the saved colours and the add button (off for a second grid in the same popover). */
  custom?: boolean;
}) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.customColors;
  const saved = useContext(SavedColorsContext);
  const [making, setMaking] = useState(false);
  const current = value?.toLowerCase();
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // The picker floats under the whole colour menu this grid sits in, not under the grid.
  const menu = useRef({
    getBoundingClientRect: () => (root.current?.closest('[data-slot="popover-content"]') ?? root.current ?? document.body).getBoundingClientRect(),
  });

  return (
    <div ref={root} className="flex flex-col gap-2">
      <div className="grid grid-cols-8 gap-1.5">
        {colors.map((color) => (
          <button
            key={color ?? 'none'}
            type="button"
            aria-label={isNone(color) ? (noneLabel ?? color ?? undefined) : color!}
            title={isNone(color) ? (noneLabel ?? color ?? undefined) : color!}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(color)}
            className={cn(SWATCH, (value ?? null) === color && SELECTED, isNone(color) && NONE)}
            style={isNone(color) ? undefined : { backgroundColor: color! }}
          />
        ))}
      </div>
      {custom && (
        <>
          <p className="text-xs font-medium text-muted-foreground">{tc.title}</p>
          <div className="grid grid-cols-8 gap-1.5">
            {saved?.colors.map((color) => (
              <div key={color} className="group relative">
                <button
                  type="button"
                  aria-label={color}
                  title={color}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(color)}
                  className={cn(SWATCH, current === color && SELECTED)}
                  style={{ backgroundColor: color }}
                />
                <button
                  type="button"
                  aria-label={tc.remove}
                  title={tc.remove}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => saved.onChange(saved.colors.filter((c) => c !== color))}
                  className="absolute -right-1 -top-1 hidden size-3.5 items-center justify-center rounded-sm bg-foreground text-background group-hover:flex focus-visible:flex [&_svg]:size-2.5"
                >
                  <X />
                </button>
              </div>
            ))}
            <button
              ref={addButton}
              type="button"
              aria-label={tc.add}
              title={tc.add}
              aria-expanded={making}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMaking((open) => !open)}
              className="inline-flex size-6 items-center justify-center rounded-sm border border-dashed text-muted-foreground transition hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground [&_svg]:size-3.5"
            >
              <Plus />
            </button>
          </div>
          <Popover open={making} onOpenChange={setMaking}>
            <PopoverAnchor virtualRef={menu} />
            <PopoverContent
              side="bottom"
              align="start"
              sideOffset={8}
              className="w-auto p-2"
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              // The add button toggles the picker itself.
              onInteractOutside={(e) => {
                if (addButton.current?.contains(e.target as Node)) e.preventDefault();
              }}
            >
              <CustomColor
                initial={value && HEX_RE.test(value) ? value : '#3b82f6'}
                onSave={(hex) => {
                  if (saved) saved.onChange([hex, ...saved.colors.filter((c) => c !== hex)].slice(0, MAX_SAVED_COLORS));
                  onPick(hex);
                  setMaking(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}

type EyeDropperApi = new () => { open: () => Promise<{ sRGBHex: string }> };

function toHex(rgba: readonly number[]): string {
  return `#${rgba
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Make a colour: a colour field, a hue slider and a hex code. */
function CustomColor({ initial, onSave }: { initial: string; onSave: (hex: string) => void }) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.customColors;
  const [hex, setHex] = useState(initial.toLowerCase());
  const [text, setText] = useState(initial.toLowerCase());
  // A typed or picked-up colour restarts the picker on it (it only takes a starting colour).
  const [seed, setSeed] = useState({ key: 0, color: initial });

  // The picker reports its colour from an effect that re-runs when `onChange`
  // changes and once on mount, so it gets a stable callback that skips the
  // mount report (the starting colour, which we already have).
  const mounting = useRef(true);
  const fromPicker = useCallback((value: unknown) => {
    if (!Array.isArray(value)) return;
    if (mounting.current) {
      mounting.current = false;
      return;
    }
    const next = toHex(value as number[]);
    setHex(next);
    setText(next);
  }, []);

  const restart = (color: string) => {
    const next = color.toLowerCase();
    setHex(next);
    setText(next);
    mounting.current = true;
    setSeed((s) => ({ key: s.key + 1, color: next }));
  };

  const eyeDropper = (globalThis as { EyeDropper?: EyeDropperApi }).EyeDropper;

  return (
    <div className="flex w-[234px] flex-col gap-3">
      <ColorPicker key={seed.key} defaultValue={seed.color} onChange={fromPicker as never} className="h-auto w-full gap-3">
        <ColorPickerSelection className="h-32 rounded-md" />
        <ColorPickerHue />
      </ColorPicker>
      <div className="flex items-center gap-1.5">
        <span className="size-8 shrink-0 rounded-sm border shadow-sm" style={{ backgroundColor: hex }} aria-hidden="true" />
        <Input
          aria-label={tc.hex}
          value={text}
          maxLength={7}
          spellCheck={false}
          className="h-8 font-mono text-xs"
          onChange={(e) => {
            const typed = e.target.value.trim();
            setText(typed);
            const full = typed.startsWith('#') ? typed : `#${typed}`;
            if (HEX_RE.test(full)) restart(full);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(hex);
          }}
        />
        {eyeDropper && (
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="size-8 shrink-0"
            aria-label={tc.eyedropper}
            title={tc.eyedropper}
            onClick={() => {
              new eyeDropper()
                .open()
                .then((result) => restart(result.sRGBHex))
                .catch(() => undefined); // Cancelled with Escape.
            }}
          >
            <Pipette className="size-4" />
          </Button>
        )}
      </div>
      <Button type="button" size="sm" onClick={() => onSave(hex)}>
        {tc.save}
      </Button>
    </div>
  );
}
